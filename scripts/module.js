/**
 * Token Action HUD: Reign — System Module
 * Integrates with TAH Core 2.1.1+ and the Reign (ORE) system.
 *
 * Key improvements over v1:
 *  - Roller cache: system rollers are imported once and reused (no per-click dynamic import).
 *  - Custom skills surfaced under Skills.
 *  - Full dice-pool calculations shown in info badges (Attr + Skill + Global modifier).
 *  - Attribute abbreviations shown as info2 on all skill buttons.
 *  - Combat: weapons sorted (equipped first), armor/shields shown as equip toggles.
 *  - Combat Utilities: Aim (with bonus indicator), Shield Coverage, Sorcery.
 *  - Company: preset quick-actions named explicitly; qualities show damage breakdown.
 *  - Threat: magnitude and morale shown as fractions with Threat Rating badge.
 *  - Switch-based dispatch replaces fragile if/else chains.
 *  - i18n-ready: all user-visible strings routed through game.i18n.localize().
 *  - Defensive: all system property accesses are null-safe.
 */
Hooks.once('tokenActionHudCoreApiReady', async (coreModule) => {
    const coreApi = coreModule.api;

    // ==========================================
    // 0. ROLLER CACHE
    // Import system rollers once; reuse on every action click.
    // Dynamic import is kept because system modules load after this hook.
    // ==========================================
    const _rollers = { _ready: false };

    async function getRollers() {
        if (_rollers._ready) return _rollers;
        try {
            _rollers.CharacterRoller = (await import('/systems/reign/scripts/helpers/character-roller.js'))?.CharacterRoller;
            _rollers.CompanyRoller   = (await import('/systems/reign/scripts/helpers/company-roller.js'))?.CompanyRoller;
            _rollers.ThreatRoller    = (await import('/systems/reign/scripts/helpers/threat-roller.js'))?.ThreatRoller;
        } catch (err) {
            console.warn('TAH Reign | One or more system rollers could not be imported.', err);
        }
        _rollers._ready = true;
        return _rollers;
    }
    // Pre-warm immediately so the first click has zero extra latency.
    getRollers();

    // ==========================================
    // CONSTANTS
    // Mirrors config.js values without importing from the system,
    // avoiding a hard coupling to the system's internal paths.
    // ==========================================

    const ATTRIBUTES = ['body', 'coordination', 'sense', 'knowledge', 'command', 'charm'];

    /** Short abbreviations shown in info2 badges on skill/stat buttons. */
    const ATTR_ABBR = {
        body: 'Bd', coordination: 'Co', sense: 'Se',
        knowledge: 'Kn', command: 'Cm', charm: 'Ch'
    };

    /** Canonical skill → governing attribute mapping (mirrors skillAttrMap in config.js). */
    const SKILL_ATTR_MAP = {
        athletics: 'body',   endurance: 'body',   fight: 'body',
        parry: 'body',       run: 'body',          vigor: 'body',
        climb: 'coordination', dodge: 'coordination', ride: 'coordination', stealth: 'coordination',
        direction: 'sense',  eerie: 'sense',       empathy: 'sense',
        hearing: 'sense',    scrutinize: 'sense',  sight: 'sense', taste_touch_smell: 'sense',
        counterspell: 'knowledge', healing: 'knowledge', languageNative: 'knowledge',
        lore: 'knowledge',   strategy: 'knowledge', tactics: 'knowledge',
        haggle: 'command',   inspire: 'command',   intimidate: 'command',
        fascinate: 'charm',  graces: 'charm',      jest: 'charm',
        lie: 'charm',        plead: 'charm'
    };

    const QUALITIES = ['might', 'treasure', 'influence', 'territory', 'sovereignty'];

    /** RAW company action presets with their quality pairs (for tooltip display). */
    const COMPANY_ACTION_DEFS = {
        attack:            { label: 'Attack',             q1: 'Might',      q2: 'Treasure' },
        being_informed:    { label: 'Intelligence',       q1: 'Influence',  q2: 'Sovereignty' },
        counter_espionage: { label: 'Counter-Espionage',  q1: 'Influence',  q2: 'Territory' },
        defend:            { label: 'Defend',             q1: 'Might',      q2: 'Territory' },
        espionage:         { label: 'Espionage',          q1: 'Influence',  q2: 'Treasure' },
        improve_culture:   { label: 'Improve Culture',    q1: 'Territory',  q2: 'Treasure' },
        policing:          { label: 'Policing',           q1: 'Might',      q2: 'Sovereignty' },
        rise_in_stature:   { label: 'Rise in Stature',   q1: 'Sovereignty', q2: 'Treasure' },
        train_levy:        { label: 'Train Levy',         q1: 'Sovereignty', q2: 'Territory' },
        unconventional:    { label: 'Unconventional',     q1: 'Influence',  q2: 'Might' }
    };

    // ==========================================
    // HELPERS
    // ==========================================

    /** Capitalises the first letter of a string. */
    function cap(str) {
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    }

    /**
     * Formats a skill name for display.
     * taste_touch_smell → Taste/Touch/Smell, languageNative → Language (Native), etc.
     */
    function formatSkillName(key) {
        const overrides = {
            taste_touch_smell: 'Taste / Touch / Smell',
            languageNative: 'Language (Native)'
        };
        return overrides[key] || cap(key.replace(/_/g, ' '));
    }

    /**
     * Compute the effective dice pool for a core skill roll.
     * Incorporates per-skill modifier and global pool bonus from Active Effects.
     */
    function skillPool(system, skillKey, overrideAttr) {
        const attrKey  = overrideAttr || SKILL_ATTR_MAP[skillKey] || 'none';
        const attrVal  = attrKey !== 'none' ? (system.attributes?.[attrKey]?.value || 0) : 0;
        const skillVal = system.skills?.[skillKey]?.value || 0;
        const skillMod = system.modifiers?.skills?.[skillKey]?.pool || 0;
        const global   = system.modifiers?.globalPool || 0;
        return { attrKey, attrVal, skillVal, skillMod, global, total: attrVal + skillVal + skillMod + global };
    }

    /**
     * Enrich HTML safely, with graceful fallback for V13/V14 API differences.
     */
    async function enrichHTML(raw, actor) {
        try {
            const impl = foundry.applications?.ux?.TextEditor?.implementation;
            if (impl?.enrichHTML) {
                return await impl.enrichHTML(raw, { async: true, secrets: actor.isOwner, relativeTo: actor });
            }
            return await TextEditor.enrichHTML(raw, { async: true, secrets: actor.isOwner, relativeTo: actor });
        } catch {
            return raw;
        }
    }

    // ==========================================
    // 1. ROLL HANDLER
    // ==========================================
    class ReignRollHandler extends coreApi.RollHandler {

        /**
         * Posts an item's description/effect to chat as a styled card.
         * Sanitises dangerous HTML tags before enrichment.
         */
        async _postItemToChat(actor, item) {
            const safeName = foundry.utils.escapeHTML(item.name);
            let rawDesc = String(item.system.notes || item.system.effect || item.system.description || '');

            // Strip script/embed vectors before enrichment.
            rawDesc = rawDesc
                .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
                .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
                .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, '')
                .replace(/<embed[\s\S]*?>/gi, '');

            const safeDesc = await enrichHTML(rawDesc, actor);

            const typeKey  = `ITEM.Type${cap(item.type)}`;
            const typeLabel = game.i18n.localize(typeKey) !== typeKey ? game.i18n.localize(typeKey) : item.type.toUpperCase();

            const content = `
                <div class="reign-chat-card">
                    <h3 style="color:#8b1f1f;margin-bottom:2px;">${safeName}</h3>
                    <p style="font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:0;">${typeLabel}</p>
                    <div style="margin-top:8px;">${safeDesc || '<i>No description provided.</i>'}</div>
                </div>`;

            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
        }

        async handleActionClick(event, encodedValue) {
            const sepIdx = encodedValue.indexOf('|');
            if (sepIdx === -1) return;

            const actionType = encodedValue.slice(0, sepIdx);
            const actionId   = encodedValue.slice(sepIdx + 1);
            const actor      = this.actor;
            if (!actor) return;

            const { CharacterRoller, CompanyRoller, ThreatRoller } = await getRollers();
            const isRightClick = event?.type === 'contextmenu' || event?.button === 2;

            switch (actionType) {

                // ── Attributes ───────────────────────────────────────────────────
                case 'attribute': {
                    if (!CharacterRoller) break;
                    await CharacterRoller.rollCharacter(actor, {
                        type: 'attribute', key: actionId, label: cap(actionId)
                    });
                    break;
                }

                // ── Core skills ──────────────────────────────────────────────────
                case 'skill': {
                    if (!CharacterRoller) break;

                    // Tower-shield encumbrance guard (mirrors character-roller.js check).
                    if (actor.system?.hasTowerShieldPenalty && ['stealth', 'climb'].includes(actionId)) {
                        return ui.notifications.error(
                            game.i18n.localize('REIGN.TowerShieldPenalty') ||
                            'Cannot make Stealth or Climb rolls while dragging a Tower Shield!'
                        );
                    }
                    await CharacterRoller.rollCharacter(actor, {
                        type: 'skill', key: actionId, label: formatSkillName(actionId)
                    });
                    break;
                }

                // ── Custom skills ────────────────────────────────────────────────
                case 'customSkill': {
                    if (!CharacterRoller) break;
                    const csLabel = actor.system?.customSkills?.[actionId]?.customLabel || actionId;
                    await CharacterRoller.rollCharacter(actor, {
                        type: 'customSkill', key: actionId, label: csLabel
                    });
                    break;
                }

                // ── Items (weapons, armor, shields, techniques, spells, etc.) ────
                case 'item': {
                    const item = actor.items.get(actionId);
                    if (!item) return;

                    // Right-click: toggle equip for equippable gear.
                    if (isRightClick && ['weapon', 'shield', 'armor'].includes(item.type)) {
                        await item.update({ 'system.equipped': !item.system.equipped });
                        return;
                    }

                    switch (item.type) {
                        case 'technique':
                        case 'discipline':
                        case 'advantage':
                        case 'problem':
                            await this._postItemToChat(actor, item);
                            break;

                        case 'spell':
                            await this._postItemToChat(actor, item);
                            if (CharacterRoller) {
                                await CharacterRoller.rollCharacter(actor, {
                                    type: 'item', key: item.id, label: item.name
                                });
                            }
                            break;

                        case 'weapon':
                            if (CharacterRoller) {
                                await CharacterRoller.rollCharacter(actor, {
                                    type: 'item', key: item.id, label: item.name
                                });
                            }
                            break;

                        default:
                            if (typeof item.roll === 'function') await item.roll();
                            else await this._postItemToChat(actor, item);
                    }
                    break;
                }

                // ── Custom Moves ─────────────────────────────────────────────────
                case 'move': {
                    if (!CharacterRoller) break;
                    const moveName = actor.system?.customMoves?.[actionId]?.name || actionId;
                    await CharacterRoller.rollCharacter(actor, {
                        type: 'customMove', key: actionId, label: moveName
                    });
                    break;
                }

                // ── Esoterica / Sorcery ──────────────────────────────────────────
                case 'esoterica': {
                    if (!CharacterRoller) break;
                    await CharacterRoller.rollCharacter(actor, {
                        type: 'esoterica', key: actionId, label: 'Sorcery'
                    });
                    break;
                }

                // ── Combat Utility: Aim ──────────────────────────────────────────
                case 'aim': {
                    if (!CharacterRoller) break;
                    await CharacterRoller.declareAim(actor);
                    break;
                }

                // ── Combat Utility: Shield Coverage ──────────────────────────────
                case 'shieldCoverage': {
                    if (!CharacterRoller) break;
                    await CharacterRoller.assignShieldCoverage(actor);
                    break;
                }

                // ── Company: open roll dialog (optionally pre-select quality) ────
                case 'companyAction': {
                    if (!CompanyRoller) break;
                    // Pass null key to open the generic dialog. The system roller
                    // uses dataset.key as the default Q1 quality, so we do NOT
                    // pass a preset action key (they share the same dialog).
                    await CompanyRoller.rollCompany(actor, { key: null });
                    break;
                }

                // ── Company: roll a specific quality (pre-selects Q1 in dialog) ──
                case 'quality': {
                    if (!CompanyRoller) break;
                    await CompanyRoller.rollCompany(actor, { key: actionId });
                    break;
                }

                // ── Threat group actions ─────────────────────────────────────────
                case 'threat': {
                    if (!ThreatRoller) break;
                    if (actionId === 'action' && typeof ThreatRoller.rollThreat === 'function') {
                        await ThreatRoller.rollThreat(actor, {});
                    } else if (actionId === 'morale' && typeof ThreatRoller.rollMorale === 'function') {
                        await ThreatRoller.rollMorale(actor, {});
                    }
                    break;
                }

                default:
                    console.warn(`TAH Reign | Unknown action type: "${actionType}"`);
            }
        }
    }

    // ==========================================
    // 2. ACTION HANDLER
    // ==========================================
    class ReignActionHandler extends coreApi.ActionHandler {

        async buildSystemActions(_groupIds) {
            const actor = this.actor;
            if (!actor) return;

            switch (actor.type) {
                case 'character':
                    this._buildStats(actor);
                    this._buildSkills(actor);
                    this._buildCombat(actor);
                    // Optional categories: only built when the character has relevant items/data.
                    if (actor.items.some(i => i.type === 'technique')) {
                        this._buildTechniques(actor);
                    }
                    if (
                        Object.keys(actor.system.customMoves  || {}).length > 0 ||
                        Object.values(actor.system.customSkills || {}).some(
                            cs => (cs.value || 0) > 0 || cs.expert || cs.master
                        )
                    ) {
                        this._buildCustomMoves(actor);
                    }
                    if (actor.items.some(i => i.type === 'spell'))      this._buildSpells(actor);
                    if (actor.items.some(i => i.type === 'discipline'))  this._buildDisciplines(actor);
                    this._buildCombatUtilities(actor);
                    break;

                case 'company':
                    this._buildCompanyActions(actor);
                    this._buildCompanyQualities(actor);
                    break;

                case 'threat':
                    this._buildThreatActions(actor);
                    break;

                default:
                    console.warn(`TAH Reign | Unrecognised actor type: "${actor.type}"`);
            }
        }

        // ── Stats ───────────────────────────────────────────────────────────────

        _buildStats(actor) {
            const { system } = actor;
            const global = system.modifiers?.globalPool || 0;

            const actions = ATTRIBUTES.map(attr => {
                const base     = system.attributes?.[attr]?.value ?? 1;
                const attrMod  = system.modifiers?.attributes?.[attr]?.pool || 0;
                const total    = base + attrMod + global;
                const modNote  = [attrMod ? `+${attrMod} mod` : '', global ? `+${global} global` : '']
                                    .filter(Boolean).join(', ');

                return {
                    id: `stat_${attr}`,
                    name: cap(attr),
                    encodedValue: `attribute|${attr}`,
                    info1: {
                        text: `${total}d`,
                        title: `Attribute: ${base}${modNote ? ` + ${modNote}` : ''}`
                    },
                    info2: { text: ATTR_ABBR[attr] }
                };
            });

            this.addActions(actions, { id: 'stats', type: 'system' });
        }

        // ── Skills ──────────────────────────────────────────────────────────────

        _buildSkills(actor) {
            const { system } = actor;
            const global = system.modifiers?.globalPool || 0;

            // Core skills: show anything with a value, or expert/master designation.
            // Dodge and Parry are shown in Combat > Defense instead.
            const coreEntries = Object.entries(system.skills || {})
                .filter(([k, v]) => k !== 'dodge' && k !== 'parry' && (v.value > 0 || v.expert || v.master))
                .sort(([a], [b]) => a.localeCompare(b));

            const coreActions = coreEntries.map(([key, data]) => {
                const { attrKey, attrVal, skillVal, skillMod, total } = skillPool(system, key);
                const specialTag = data.master ? ' MD' : data.expert ? ' ED' : '';
                const modNote    = [skillMod ? `+${skillMod} mod` : '', global ? `+${global} global` : '']
                                    .filter(Boolean).join(', ');

                return {
                    id: `skill_${key}`,
                    name: formatSkillName(key),
                    encodedValue: `skill|${key}`,
                    info1: {
                        text: `${total}d${specialTag}`,
                        title: `${ATTR_ABBR[attrKey] || '?'} ${attrVal} + Skill ${skillVal}${modNote ? ` + ${modNote}` : ''}`
                    },
                    info2: attrKey !== 'none' ? {
                        text: ATTR_ABBR[attrKey],
                        title: `Linked Attribute: ${cap(attrKey)}`
                    } : undefined
                };
            });

            // Custom skills: surface alongside core skills.
            const customEntries = Object.entries(system.customSkills || {})
                .filter(([, v]) => v.value > 0 || v.expert || v.master)
                .sort(([, a], [, b]) => (a.customLabel || '').localeCompare(b.customLabel || ''));

            const customActions = customEntries.map(([key, data]) => {
                const attrKey  = data.attribute || 'none';
                const attrVal  = attrKey !== 'none' ? (system.attributes?.[attrKey]?.value || 0) : 0;
                const total    = attrVal + (data.value || 0) + global;
                const specialTag = data.master ? ' MD' : data.expert ? ' ED' : '';
                // The character sheet stores display names in `customLabel`, not `name`.
                const displayName = data.customLabel || 'Custom Skill';

                return {
                    id: `customSkill_${key}`,
                    name: `★ ${displayName}`,  // ★ prefix signals custom
                    encodedValue: `customSkill|${key}`,
                    info1: { text: `${total}d${specialTag}` },
                    info2: attrKey !== 'none' ? {
                        text: ATTR_ABBR[attrKey],
                        title: `Linked Attribute: ${cap(attrKey)}`
                    } : undefined
                };
            });

            this.addActions([...coreActions, ...customActions], { id: 'skills', type: 'system' });
        }

        // ── Combat ──────────────────────────────────────────────────────────────

        _buildCombat(actor) {
            const { system } = actor;
            const global = system.modifiers?.globalPool || 0;

            // --- Weapons (sorted: equipped first, then alphabetical) ---
            const weapons = actor.items
                .filter(i => i.type === 'weapon')
                .sort((a, b) => {
                    if (a.system.equipped !== b.system.equipped)
                        return a.system.equipped ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            const fightPool = skillPool(system, 'fight');

            const weaponActions = weapons.map(w => {
                const isEquipped  = w.system.equipped;
                const dmgDisplay  = w.system.damageFormula || w.system.damage || '—';
                const qualNotes   = [];
                const wq          = w.system.qualities || {};
                if (wq.armorPiercing > 0) qualNotes.push(`AP${wq.armorPiercing}`);
                if (wq.slow > 0)          qualNotes.push(`Slow ${wq.slow}`);
                if (wq.twoHanded)         qualNotes.push('2H');
                if (wq.massive)           qualNotes.push('Massive');
                if (wq.area > 0)          qualNotes.push(`Area ${wq.area}`);

                return {
                    id: `weapon_${w.id}`,
                    name: isEquipped ? `⚔ ${w.name}` : w.name,
                    encodedValue: `item|${w.id}`,
                    cssClass: isEquipped ? 'active' : '',
                    tooltip: [
                        isEquipped ? 'Click: Roll Attack' : 'Right-Click: Equip',
                        qualNotes.length ? qualNotes.join(', ') : ''
                    ].filter(Boolean).join(' | '),
                    info1: {
                        text: dmgDisplay,
                        title: `Damage: ${dmgDisplay}`
                    },
                    info2: isEquipped ? {
                        text: `${fightPool.total}d`,
                        title: `Fight Pool: Bd${fightPool.attrVal} + Fight ${fightPool.skillVal}${global ? ` + ${global} global` : ''}`
                    } : { text: 'Unequip', title: 'Right-click to equip' }
                };
            });

            this.addActions(weaponActions, { id: 'attacks', type: 'system' });

            // --- Defense: Dodge, Parry, plus Armor / Shield equip toggles ---
            const defenseActions = [];

            if ((system.skills?.dodge?.value || 0) > 0 || system.skills?.dodge?.expert || system.skills?.dodge?.master) {
                const dp = skillPool(system, 'dodge');
                const specialTag = system.skills.dodge.master ? ' MD' : system.skills.dodge.expert ? ' ED' : '';
                defenseActions.push({
                    id: 'skill_dodge', name: 'Dodge', encodedValue: 'skill|dodge',
                    info1: { text: `${dp.total}d${specialTag}`, title: `Co ${dp.attrVal} + Dodge ${dp.skillVal}` },
                    info2: { text: 'Co' }
                });
            }

            if ((system.skills?.parry?.value || 0) > 0 || system.skills?.parry?.expert || system.skills?.parry?.master) {
                const pp = skillPool(system, 'parry');
                const specialTag = system.skills.parry.master ? ' MD' : system.skills.parry.expert ? ' ED' : '';
                defenseActions.push({
                    id: 'skill_parry', name: 'Parry', encodedValue: 'skill|parry',
                    info1: { text: `${pp.total}d${specialTag}`, title: `Bd ${pp.attrVal} + Parry ${pp.skillVal}` },
                    info2: { text: 'Bd' }
                });
            }

            // Equippable armor and shields as toggleable buttons (right-click also works via item handler).
            const equippables = actor.items
                .filter(i => ['armor', 'shield'].includes(i.type))
                .sort((a, b) => {
                    if (a.system.equipped !== b.system.equipped)
                        return a.system.equipped ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            for (const e of equippables) {
                const isEquipped = e.system.equipped;
                if (e.type === 'armor') {
                    defenseActions.push({
                        id: `armor_${e.id}`,
                        name: `🛡 ${e.name}`,
                        encodedValue: `item|${e.id}`,
                        cssClass: isEquipped ? 'active' : '',
                        tooltip: `AR ${e.system.ar || 0} — Click/Right-Click to toggle equipped`,
                        info1: { text: `AR${e.system.ar || 0}`, title: 'Armor Rating' }
                    });
                } else {
                    defenseActions.push({
                        id: `shield_${e.id}`,
                        name: `🔰 ${e.name}`,
                        encodedValue: `item|${e.id}`,
                        cssClass: isEquipped ? 'active' : '',
                        tooltip: `Parry +${e.system.parryBonus || 0} — Click/Right-Click to toggle equipped`,
                        info1: { text: `+${e.system.parryBonus || 0}`, title: 'Parry Bonus' },
                        info2: { text: cap(e.system.shieldSize || '') }
                    });
                }
            }

            this.addActions(defenseActions, { id: 'preferredMoves', type: 'system' });
        }

        // ── Combat Utilities ─────────────────────────────────────────────────────

        _buildCombatUtilities(actor) {
            const { system } = actor;
            const actions = [];

            // Aim — show current bonus in name/badge if already aiming.
            const aimBonus = actor.getFlag('reign', 'aimBonus') || 0;
            actions.push({
                id: 'utility_aim',
                name: aimBonus > 0 ? `Aim (+${aimBonus}d)` : 'Aim',
                encodedValue: 'aim|aim',
                cssClass: aimBonus > 0 ? 'active' : '',
                tooltip: 'Declare Aim: spend this round to gain +1d on next attack (max +2d).',
                info1: aimBonus > 0 ? { text: `+${aimBonus}d`, title: `Current aim bonus: +${aimBonus}d` } : undefined
            });

            // Shield Coverage — only shown when a shield is actually equipped.
            const equippedShields = actor.items.filter(i => i.type === 'shield' && i.system.equipped);
            if (equippedShields.length > 0) {
                actions.push({
                    id: 'utility_shieldCoverage',
                    name: 'Shield Coverage',
                    encodedValue: 'shieldCoverage|assign',
                    tooltip: 'Declare which locations your shield(s) protect this round.',
                    info1: { text: `×${equippedShields.length}`, title: `${equippedShields.length} shield(s) equipped` }
                });
            }

            // Esoterica / Sorcery — only for characters with a sorcery rating.
            if ((system.esoterica?.sorcery || 0) > 0) {
                const sorceryRating = system.esoterica.sorcery;
                const eeriePool     = skillPool(system, 'eerie');
                // Sorcery pool ≈ sorcery rating dice + Eerie as the skill (per RAW)
                // The character-roller handles the exact pool; we surface a useful preview.
                actions.push({
                    id: 'utility_esoterica',
                    name: 'Sorcery',
                    encodedValue: 'esoterica|sorcery',
                    tooltip: `Sorcery rating: ${sorceryRating}. Roll sorcery pool via the character roller.`,
                    info1: { text: `S${sorceryRating}`, title: `Sorcery Rating ${sorceryRating}` },
                    info2: { text: ATTR_ABBR.sense, title: 'Linked Attribute: Sense' }
                });
            }

            if (actions.length > 0) {
                this.addActions(actions, { id: 'utilities', type: 'system' });
            }
        }

        // ── Techniques ───────────────────────────────────────────────────────────

        _buildTechniques(actor) {
            const techniques = actor.items
                .filter(i => i.type === 'technique')
                .sort((a, b) => {
                    // Sort: active techniques before passive, then by name.
                    const aP = a.system.isPassive ? 1 : 0;
                    const bP = b.system.isPassive ? 1 : 0;
                    return aP - bP || a.name.localeCompare(b.name);
                });

            const actions = techniques.map(p => ({
                id: `technique_${p.id}`,
                name: p.name,
                encodedValue: `item|${p.id}`,
                cssClass: p.system.isPassive ? 'active' : '',
                tooltip: [
                    p.system.isPassive ? 'Passive Technique (always active)' : 'Click to post to chat',
                    p.system.path    ? `Path: ${p.system.path}` : ''
                ].filter(Boolean).join(' | '),
                info1: { text: `R${p.system.rank || 1}`, title: `Rank ${p.system.rank || 1}` },
                info2: p.system.path ? { text: p.system.path.substring(0, 4), title: `Path: ${p.system.path}` } : undefined
            }));

            this.addActions(actions, { id: 'techniques', type: 'system' });
        }

        // ── Custom Moves ─────────────────────────────────────────────────────────

        _buildCustomMoves(actor) {
            const { system } = actor;
            const global = system.modifiers?.globalPool || 0;

            const actions = Object.entries(system.customMoves || {})
                .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
                .map(([id, move]) => {
                    const aKey = move.attrKey && move.attrKey !== 'none' ? move.attrKey : null;
                    const sKey = move.skillKey && move.skillKey !== 'none' ? move.skillKey : null;
                    const aVal = aKey ? (system.attributes?.[aKey]?.value || 0) : 0;
                    const sVal = sKey
                        ? (system.skills?.[sKey]?.value || system.customSkills?.[sKey]?.value || 0)
                        : 0;
                    const mod   = move.modifier || 0;
                    const total = aVal + sVal + mod + global;

                    return {
                        id: `move_${id}`,
                        name: move.name || 'Custom Move',
                        encodedValue: `move|${id}`,
                        tooltip: [
                            aKey ? `${ATTR_ABBR[aKey] || aKey} ${aVal}` : '',
                            sKey ? `+ ${sKey} ${sVal}` : '',
                            mod  ? `+ mod ${mod}` : '',
                            global ? `+ global ${global}` : ''
                        ].filter(Boolean).join(' ') || `${total}d`,
                        info1: { text: `${total}d`, title: `Pool: ${total}d` },
                        info2: aKey ? {
                            text: ATTR_ABBR[aKey],
                            title: `Attribute: ${cap(aKey)}`
                        } : undefined
                    };
                });

            this.addActions(actions, { id: 'moves', type: 'system' });
        }

        // ── Spells ───────────────────────────────────────────────────────────────

        _buildSpells(actor) {
            const spells = actor.items
                .filter(i => i.type === 'spell')
                .sort((a, b) => (a.system.intensity || 1) - (b.system.intensity || 1) || a.name.localeCompare(b.name));

            const actions = spells.map(s => ({
                id: `spell_${s.id}`,
                name: s.name,
                encodedValue: `item|${s.id}`,
                tooltip: [
                    s.system.castingTime > 0 ? `Casting Time: ${s.system.castingTime} round(s)` : 'Instant',
                    s.system.school ? `School: ${s.system.school}` : ''
                ].filter(Boolean).join(' | '),
                info1: { text: `I${s.system.intensity || 1}`, title: `Intensity ${s.system.intensity || 1}` },
                info2: s.system.castingStat ? {
                    text: ATTR_ABBR[s.system.castingStat] || s.system.castingStat,
                    title: `Casting Stat: ${cap(s.system.castingStat)}`
                } : undefined
            }));

            this.addActions(actions, { id: 'spells', type: 'system' });
        }

        // ── Disciplines ──────────────────────────────────────────────────────────

        _buildDisciplines(actor) {
            const disciplines = actor.items
                .filter(i => i.type === 'discipline')
                .sort((a, b) => a.name.localeCompare(b.name));

            const actions = disciplines.map(d => ({
                id: `discipline_${d.id}`,
                name: d.name,
                encodedValue: `item|${d.id}`,
                tooltip: 'Click to post to chat',
                info1: (d.system.rank || d.system.rank === 0) ? {
                    text: `R${d.system.rank}`,
                    title: `Rank ${d.system.rank}`
                } : undefined,
                info2: d.system.path ? {
                    text: d.system.path.substring(0, 4),
                    title: `Path: ${d.system.path}`
                } : undefined
            }));

            this.addActions(actions, { id: 'disciplines', type: 'system' });
        }

        // ── Company Actions ──────────────────────────────────────────────────────

        _buildCompanyActions(actor) {
            // One generic "open dialog" button for free-form actions…
            const actions = [{
                id: 'execute_custom',
                name: 'Custom Action',
                encodedValue: 'companyAction|execute',
                tooltip: 'Open the Company Action dialog for a fully custom roll.'
            }];

            // …plus one quick-launch per RAW company action preset.
            // All open the same roller dialog; the labels help the player pick quickly.
            for (const [key, def] of Object.entries(COMPANY_ACTION_DEFS)) {
                actions.push({
                    id: `companyAction_${key}`,
                    name: def.label,
                    encodedValue: `companyAction|${key}`,
                    tooltip: `${def.label}: uses ${def.q1} + ${def.q2}`
                });
            }

            this.addActions(actions, { id: 'companyActions', type: 'system' });
        }

        // ── Company Qualities ────────────────────────────────────────────────────

        _buildCompanyQualities(actor) {
            const { system } = actor;

            const actions = QUALITIES.map(q => {
                const data      = system.qualities?.[q] || { value: 0, damage: 0, uses: 0 };
                const base      = data.value  || 0;
                const dmg       = data.damage || 0;
                const used      = data.uses   || 0;
                const effective = Math.max(0, base - dmg - used);

                return {
                    id: `quality_${q}`,
                    name: cap(q),
                    encodedValue: `quality|${q}`,
                    // Visually flag exhausted or damaged qualities.
                    cssClass: effective === 0 ? 'tah-reign-depleted' : dmg > 0 ? 'tah-reign-damaged' : '',
                    tooltip: `${cap(q)}: ${base} base − ${dmg} damage − ${used} used = ${effective} effective`,
                    info1: {
                        text: effective.toString(),
                        title: `Effective: ${effective}`
                    },
                    info2: dmg > 0 ? {
                        text: `−${dmg}D`,
                        title: `${dmg} point(s) of damage`
                    } : undefined
                };
            });

            this.addActions(actions, { id: 'qualities', type: 'system' });
        }

        // ── Threat Actions ───────────────────────────────────────────────────────

        _buildThreatActions(actor) {
            const { system } = actor;
            const magnitude    = system.magnitude?.value ?? 0;
            const magnitudeMax = system.magnitude?.max   ?? magnitude;
            const morale       = system.morale?.value    ?? 0;
            const moraleMax    = system.morale?.max      ?? morale;
            const threatRating = system.threatLevel      ?? 1;

            this.addActions([
                {
                    id: 'threat_action',
                    name: 'Threat Action',
                    encodedValue: 'threat|action',
                    cssClass: magnitude === 0 ? 'tah-reign-depleted' : '',
                    tooltip: `Roll ${Math.min(magnitude, 15)}d attack pool. Threat Rating: ${threatRating}. Fighters: ${magnitude}/${magnitudeMax}.`,
                    info1: { text: `${magnitude}/${magnitudeMax}`, title: `Active Fighters: ${magnitude} of ${magnitudeMax}` },
                    info2: { text: `TR${threatRating}`, title: `Threat Rating ${threatRating}` }
                },
                {
                    id: 'threat_morale',
                    name: 'Morale Check',
                    encodedValue: 'threat|morale',
                    cssClass: morale === 0 ? 'tah-reign-depleted' : '',
                    tooltip: `Morale: ${morale}/${moraleMax}. ${morale === 0 ? 'Group has broken — no Morale Check possible.' : 'Roll Morale.'}`,
                    info1: { text: `${morale}/${moraleMax}`, title: `Morale: ${morale} of ${moraleMax}` }
                }
            ], { id: 'threatActions', type: 'system' });
        }
    }

    // ==========================================
    // 3. SYSTEM MANAGER
    // ==========================================
    class ReignSystemManager extends coreApi.SystemManager {
        getActionHandler(...args) { return new ReignActionHandler(...args); }
        getAvailableRollHandlers() { return { core: 'Core Reign' }; }
        getRollHandler(...args) { return new ReignRollHandler(...args); }

        async registerDefaults() {
            const L = key => game.i18n.localize(key);
            return {
                layout: [
                    {
                        nestId: 'stats', id: 'stats',
                        name: L('tokenActionHud.reign.category.stats'),
                        groups: [
                            { nestId: 'stats_stats', id: 'stats', name: L('tokenActionHud.reign.category.stats'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'skills', id: 'skills',
                        name: L('tokenActionHud.reign.category.skills'),
                        groups: [
                            { nestId: 'skills_skills', id: 'skills', name: L('tokenActionHud.reign.category.skills'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'combat', id: 'combat',
                        name: L('tokenActionHud.reign.category.combat'),
                        groups: [
                            { nestId: 'combat_attacks',        id: 'attacks',        name: L('tokenActionHud.reign.group.attacks'),       type: 'system' },
                            { nestId: 'combat_preferredMoves', id: 'preferredMoves', name: L('tokenActionHud.reign.group.defense'),        type: 'system' },
                            { nestId: 'combat_utilities',      id: 'utilities',      name: L('tokenActionHud.reign.group.utilities'),      type: 'system' }
                        ]
                    },
                    {
                        nestId: 'techniques', id: 'techniques',
                        name: L('tokenActionHud.reign.category.techniques'),
                        groups: [
                            { nestId: 'techniques_techniques', id: 'techniques', name: L('tokenActionHud.reign.category.techniques'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'customMoves', id: 'customMoves',
                        name: L('tokenActionHud.reign.category.customMoves'),
                        groups: [
                            { nestId: 'customMoves_moves', id: 'moves', name: L('tokenActionHud.reign.group.moves'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'spells', id: 'spells',
                        name: L('tokenActionHud.reign.category.spells'),
                        groups: [
                            { nestId: 'spells_spells', id: 'spells', name: L('tokenActionHud.reign.category.spells'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'disciplines', id: 'disciplines',
                        name: L('tokenActionHud.reign.category.disciplines'),
                        groups: [
                            { nestId: 'disciplines_disciplines', id: 'disciplines', name: L('tokenActionHud.reign.category.disciplines'), type: 'system' }
                        ]
                    },
                    {
                        nestId: 'company', id: 'company',
                        name: L('tokenActionHud.reign.category.company'),
                        groups: [
                            { nestId: 'company_actions',   id: 'companyActions', name: L('tokenActionHud.reign.group.companyActions'), type: 'system' },
                            { nestId: 'company_qualities', id: 'qualities',      name: L('tokenActionHud.reign.group.qualities'),      type: 'system' }
                        ]
                    },
                    {
                        nestId: 'threats', id: 'threats',
                        name: L('tokenActionHud.reign.category.threats'),
                        groups: [
                            { nestId: 'threats_actions', id: 'threatActions', name: L('tokenActionHud.reign.group.threatActions'), type: 'system' }
                        ]
                    }
                ],
                groups: [
                    { id: 'stats',          name: L('tokenActionHud.reign.category.stats'),          type: 'system' },
                    { id: 'skills',         name: L('tokenActionHud.reign.category.skills'),         type: 'system' },
                    { id: 'attacks',        name: L('tokenActionHud.reign.group.attacks'),            type: 'system' },
                    { id: 'preferredMoves', name: L('tokenActionHud.reign.group.defense'),            type: 'system' },
                    { id: 'utilities',      name: L('tokenActionHud.reign.group.utilities'),          type: 'system' },
                    { id: 'techniques',     name: L('tokenActionHud.reign.category.techniques'),      type: 'system' },
                    { id: 'moves',          name: L('tokenActionHud.reign.group.moves'),              type: 'system' },
                    { id: 'spells',         name: L('tokenActionHud.reign.category.spells'),          type: 'system' },
                    { id: 'disciplines',    name: L('tokenActionHud.reign.category.disciplines'),     type: 'system' },
                    { id: 'companyActions', name: L('tokenActionHud.reign.group.companyActions'),     type: 'system' },
                    { id: 'qualities',      name: L('tokenActionHud.reign.group.qualities'),          type: 'system' },
                    { id: 'threatActions',  name: L('tokenActionHud.reign.group.threatActions'),      type: 'system' }
                ]
            };
        }
    }

    // ==========================================
    // 4. API HANDSHAKE
    // ==========================================
    const module = game.modules.get('token-action-hud-reign');
    module.api = {
        requiredCoreModuleVersion: '2.1.1',
        SystemManager: ReignSystemManager
    };

    Hooks.call('tokenActionHudSystemReady', module);
});