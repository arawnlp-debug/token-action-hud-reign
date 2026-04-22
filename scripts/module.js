/**
 * Unified Token Action HUD Integration for Reign.
 * Custom Layout: Stats, Skills, Combat, Techniques, Custom Moves, Spells, Disciplines.
 * Fully integrates CharacterRoller, CompanyRoller, and ThreatRoller.
 */
Hooks.once('tokenActionHudCoreApiReady', async (coreModule) => {
    const coreApi = coreModule.api;

    // ==========================================
    // 1. ROLL HANDLER
    // ==========================================
    class ReignRollHandler extends coreApi.RollHandler {
        
        async _postItemToChat(actor, item) {
            const safeName = foundry.utils.escapeHTML(item.name);
            let rawDesc = String(item.system.notes || item.system.effect || item.system.description || "");
            
            rawDesc = rawDesc.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
                             .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
                             .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
                             .replace(/<embed[\s\S]*?>/gi, "");

            let safeDesc = rawDesc;
            try {
                if (foundry.applications?.ux?.TextEditor?.implementation?.enrichHTML) {
                    safeDesc = await foundry.applications.ux.TextEditor.implementation.enrichHTML(rawDesc, { async: true, secrets: actor.isOwner, relativeTo: actor });
                } else {
                    safeDesc = await TextEditor.enrichHTML(rawDesc, { async: true, secrets: actor.isOwner, relativeTo: actor });
                }
            } catch (e) {
                console.warn("TAH Reign | Fallback text enrichment used.");
            }

            const content = `
                <div class="reign-chat-card">
                    <h3 style="color: #8b1f1f; margin-bottom: 2px;">${safeName}</h3>
                    <p style="font-weight: bold; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-top: 0;">${item.type.toUpperCase()}</p>
                    <div style="margin-top: 8px;">${safeDesc || "<i>No description provided.</i>"}</div>
                </div>`;
            
            await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
        }

        async handleActionClick(event, encodedValue) {
            const payload = encodedValue.split('|');
            if (payload.length !== 2) return;
            
            const actionType = payload[0];
            const actionId = payload[1];
            const actor = this.actor;

            if (!actor) return;

            let CharacterRoller, CompanyRoller, ThreatRoller;
            try {
                CharacterRoller = (await import('/systems/reign/scripts/helpers/character-roller.js'))?.CharacterRoller;
                CompanyRoller = (await import('/systems/reign/scripts/helpers/company-roller.js'))?.CompanyRoller;
                ThreatRoller = (await import('/systems/reign/scripts/helpers/threat-roller.js'))?.ThreatRoller;
            } catch (err) {
                console.warn("TAH Reign | One or more system rollers could not be located.");
            }

            switch (actionType) {
                case 'attribute': 
                case 'skill':
                    if (actor.system.hasTowerShieldPenalty && (actionId.toLowerCase() === "stealth" || actionId.toLowerCase() === "climb")) {
                        return ui.notifications.error("Cannot make Stealth or Climb rolls while dragging a massive Tower Shield!");
                    }
                    if (CharacterRoller) await CharacterRoller.rollCharacter(actor, { type: actionType, key: actionId, label: actionId });
                    break;
                    
                case 'item':
                    const item = actor.items.get(actionId);
                    if (!item) return;

                    if (event.type === 'contextmenu' || event.button === 2) {
                        if (['weapon', 'shield', 'armor'].includes(item.type)) {
                            return await item.update({ "system.equipped": !item.system.equipped });
                        }
                    }

                    if (['discipline', 'technique'].includes(item.type)) {
                        return this._postItemToChat(actor, item);
                    }

                    if (item.type === 'spell') {
                        await this._postItemToChat(actor, item);
                        if (CharacterRoller && typeof CharacterRoller.rollCharacter === 'function') {
                            await CharacterRoller.rollCharacter(actor, { type: 'item', key: item.id, label: item.name });
                        }
                        return;
                    }

                    if (item.type === 'weapon') {
                        if (CharacterRoller && typeof CharacterRoller.rollCharacter === 'function') {
                            await CharacterRoller.rollCharacter(actor, { type: 'item', key: item.id, label: item.name });
                            return;
                        }
                    }

                    if (typeof item.roll === 'function') {
                        await item.roll();
                    } else {
                        return this._postItemToChat(actor, item);
                    }
                    break;

                case 'move':
                    if (CharacterRoller) await CharacterRoller.rollCharacter(actor, { type: 'customMove', key: actionId });
                    break;

                case 'companyAction':
                    if (CompanyRoller) await CompanyRoller.rollCompany(actor, { key: null }); // Opens generic action dialog
                    break;
                    
                case 'quality':
                    if (CompanyRoller) await CompanyRoller.rollCompany(actor, { key: actionId });
                    break;
                    
                case 'threat':
                    if (ThreatRoller) {
                        if (actionId === 'action' && typeof ThreatRoller.rollThreat === 'function') {
                            await ThreatRoller.rollThreat(actor, {});
                        } else if (actionId === 'morale' && typeof ThreatRoller.rollMorale === 'function') {
                            await ThreatRoller.rollMorale(actor, {});
                        }
                    }
                    break;
            }
        }
    }

    // ==========================================
    // 2. ACTION HANDLER
    // ==========================================
    class ReignActionHandler extends coreApi.ActionHandler {
        async buildSystemActions(groupIds) {
            const actor = this.actor;
            if (!actor) return;

            if (actor.type === 'character') {
                this._buildStats(actor);
                this._buildSkills(actor);
                this._buildCombat(actor);
                this._buildTechniques(actor);
                this._buildCustomMoves(actor);
                this._buildSpells(actor);
                this._buildDisciplines(actor);
            } else if (actor.type === 'company') {
                this._buildCompanyActions(actor);
                this._buildCompanyQualities(actor);
            } else if (actor.type === 'threat') {
                this._buildThreatActions(actor);
            }
        }
        
        _buildStats(actor) {
            const attributes = ['body', 'coordination', 'sense', 'knowledge', 'command', 'charm'];
            this.addActions(attributes.map(attr => ({
                id: `stat_${attr}`, name: attr.charAt(0).toUpperCase() + attr.slice(1), encodedValue: `attribute|${attr}`,
                info1: { text: actor.system.attributes[attr]?.value?.toString() || '1' }
            })), { id: 'stats', type: 'system' });
        }
        
        _buildSkills(actor) {
            const skills = Object.entries(actor.system.skills || {})
                .filter(([k, v]) => (v.value > 0 || v.master || v.expert) && k !== 'dodge' && k !== 'parry');
            this.addActions(skills.map(([key, data]) => ({
                id: `skill_${key}`, name: key.charAt(0).toUpperCase() + key.slice(1), encodedValue: `skill|${key}`,
                info1: { text: data.value.toString() + (data.expert ? ' (ED)' : '') + (data.master ? ' (MD)' : '') }
            })), { id: 'skills', type: 'system' });
        }

        _buildCombat(actor) {
            const weapons = actor.items.filter(i => i.type === 'weapon');
            this.addActions(weapons.map(w => ({
                id: `weapon_${w.id}`, name: w.system.equipped ? `⚔️ ${w.name}` : w.name, encodedValue: `item|${w.id}`,
                cssClass: w.system.equipped ? 'active' : '', tooltip: 'Left-Click to Attack. Right-Click to Equip/Unequip.',
                info1: { text: w.system.damageFormula || w.system.damage || 'W' }, info2: { text: w.system.equipped ? 'Eq' : '' }
            })), { id: 'attacks', type: 'system' });

            const defenses = [];
            if (actor.system.skills?.dodge) defenses.push({ id: 'skill_dodge', name: 'Dodge', encodedValue: 'skill|dodge', info1: { text: actor.system.skills.dodge.value.toString() } });
            if (actor.system.skills?.parry) defenses.push({ id: 'skill_parry', name: 'Parry', encodedValue: 'skill|parry', info1: { text: actor.system.skills.parry.value.toString() } });
            this.addActions(defenses, { id: 'preferredMoves', type: 'system' });
        }

        _buildTechniques(actor) {
            const paths = actor.items.filter(i => i.type === 'technique');
            this.addActions(paths.map(p => ({
                id: `technique_${p.id}`, name: p.name, encodedValue: `item|${p.id}`, info1: { text: `Rank ${p.system.rank || 1}` }
            })), { id: 'techniques', type: 'system' });
        }

        _buildCustomMoves(actor) {
            const moves = actor.system.customMoves || {};
            this.addActions(Object.entries(moves).map(([id, move]) => {
                let aVal = move.attrKey !== "none" ? (actor.system.attributes[move.attrKey]?.value || 0) : 0;
                let sVal = 0;
                if (move.skillKey !== "none") {
                    if (actor.system.skills[move.skillKey]) sVal = actor.system.skills[move.skillKey].value || 0;
                    else if (actor.system.customSkills && actor.system.customSkills[move.skillKey]) sVal = actor.system.customSkills[move.skillKey].value || 0;
                }
                return { id: `move_${id}`, name: move.name || "Custom Move", encodedValue: `move|${id}`, info1: { text: `${aVal + sVal + (move.modifier || 0)}d` } };
            }), { id: 'moves', type: 'system' });
        }

        _buildSpells(actor) {
            const spells = actor.items.filter(i => i.type === 'spell');
            this.addActions(spells.map(s => ({
                id: `spell_${s.id}`, name: s.name, encodedValue: `item|${s.id}`, info1: { text: `Int ${s.system.intensity || 1}` }
            })), { id: 'spells', type: 'system' });
        }

        _buildDisciplines(actor) {
            const disciplines = actor.items.filter(i => i.type === 'discipline');
            this.addActions(disciplines.map(d => ({
                id: `discipline_${d.id}`, name: d.name, encodedValue: `item|${d.id}`
            })), { id: 'disciplines', type: 'system' });
        }

        _buildCompanyActions(actor) {
            this.addActions([{
                id: 'execute_action', name: 'Execute Company Action', encodedValue: 'companyAction|execute', tooltip: 'Opens the Company Action Dialog to select Maneuvers and Targets.'
            }], { id: 'companyActions', type: 'system' });
        }

        _buildCompanyQualities(actor) {
            const qualities = ['might', 'treasure', 'influence', 'territory', 'sovereignty'];
            this.addActions(qualities.map(q => {
                const data = actor.system.qualities[q];
                const current = Math.max(0, (data.value || 0) - (data.damage || 0) - (data.uses || 0));
                return { id: `quality_${q}`, name: q.charAt(0).toUpperCase() + q.slice(1), encodedValue: `quality|${q}`, info1: { text: current.toString() } };
            }), { id: 'qualities', type: 'system' });
        }

        _buildThreatActions(actor) {
            this.addActions([
                { id: 'threat_action', name: 'Threat Action', encodedValue: 'threat|action', info1: { text: actor.system.magnitude?.value?.toString() || '0' } },
                { id: 'threat_morale', name: 'Morale Check', encodedValue: 'threat|morale', info1: { text: actor.system.morale?.value?.toString() || '0' } }
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
            return {
                layout: [
                    { nestId: 'stats', id: 'stats', name: 'Stats', groups: [{ nestId: 'stats_stats', id: 'stats', name: 'Stats', type: 'system' }] },
                    { nestId: 'skills', id: 'skills', name: 'Skills', groups: [{ nestId: 'skills_skills', id: 'skills', name: 'Skills', type: 'system' }] },
                    { nestId: 'combat', id: 'combat', name: 'Combat', groups: [
                        { nestId: 'combat_attacks', id: 'attacks', name: 'Attacks', type: 'system' },
                        { nestId: 'combat_preferredMoves', id: 'preferredMoves', name: 'Preferred Moves', type: 'system' }
                    ]},
                    { nestId: 'techniques', id: 'techniques', name: 'Techniques', groups: [{ nestId: 'techniques_techniques', id: 'techniques', name: 'Techniques', type: 'system' }] },
                    { nestId: 'customMoves', id: 'customMoves', name: 'Custom Moves', groups: [{ nestId: 'customMoves_moves', id: 'moves', name: 'Moves', type: 'system' }] },
                    { nestId: 'spells', id: 'spells', name: 'Spells', groups: [{ nestId: 'spells_spells', id: 'spells', name: 'Spells', type: 'system' }] },
                    { nestId: 'disciplines', id: 'disciplines', name: 'Disciplines', groups: [{ nestId: 'disciplines_disciplines', id: 'disciplines', name: 'Disciplines', type: 'system' }] },
                    { nestId: 'company', id: 'company', name: 'Company', groups: [
                        { nestId: 'company_actions', id: 'companyActions', name: 'Actions', type: 'system' },
                        { nestId: 'company_qualities', id: 'qualities', name: 'Qualities', type: 'system' }
                    ]},
                    { nestId: 'threats', id: 'threats', name: 'Threats', groups: [{ nestId: 'threats_actions', id: 'threatActions', name: 'Actions', type: 'system' }] }
                ],
                groups: [
                    { id: 'stats', name: 'Stats', type: 'system' }, { id: 'skills', name: 'Skills', type: 'system' },
                    { id: 'attacks', name: 'Attacks', type: 'system' }, { id: 'preferredMoves', name: 'Preferred Moves', type: 'system' },
                    { id: 'techniques', name: 'Techniques', type: 'system' }, { id: 'moves', name: 'Moves', type: 'system' },
                    { id: 'spells', name: 'Spells', type: 'system' }, { id: 'disciplines', name: 'Disciplines', type: 'system' },
                    { id: 'companyActions', name: 'Actions', type: 'system' }, { id: 'qualities', name: 'Qualities', type: 'system' },
                    { id: 'threatActions', name: 'Actions', type: 'system' }
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