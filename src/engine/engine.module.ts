import { Module } from '@nestjs/common';
import { RngService } from './rng/rng.service.js';
import { StatsService } from './stats/stats.service.js';
import { StatusService } from './status/status.service.js';
import { HitService } from './combat/hit.service.js';
import { DamageService } from './combat/damage.service.js';
import { EnemyAiService } from './combat/enemy-ai.service.js';
import { CombatService } from './combat/combat.service.js';
import { RuleParserService } from './input/rule-parser.service.js';
import { PolicyService } from './input/policy.service.js';
import { ActionPlanService } from './input/action-plan.service.js';
import { NodeResolverService } from './nodes/node-resolver.service.js';
import { CombatNodeService } from './nodes/combat-node.service.js';
import { EventNodeService } from './nodes/event-node.service.js';
import { RestNodeService } from './nodes/rest-node.service.js';
import { ShopNodeService } from './nodes/shop-node.service.js';
import { ExitNodeService } from './nodes/exit-node.service.js';
import { RewardsService } from './rewards/rewards.service.js';
import { InventoryService } from './rewards/inventory.service.js';
import { NodeTransitionService } from './nodes/node-transition.service.js';
import { HubEngineModule } from './hub/hub-engine.module.js';

const providers = [
  // Layer 3
  RngService,
  // Layer 4
  StatsService,
  // Layer 5
  StatusService,
  // Layer 6
  HitService,
  DamageService,
  EnemyAiService,
  CombatService,
  // Layer 7
  RuleParserService,
  PolicyService,
  ActionPlanService,
  // Layer 8
  NodeResolverService,
  CombatNodeService,
  EventNodeService,
  RestNodeService,
  ShopNodeService,
  ExitNodeService,
  // Layer 9
  RewardsService,
  InventoryService,
  // Layer 10 — Transition
  NodeTransitionService,
];

@Module({
  imports: [HubEngineModule],
  providers,
  exports: [...providers, HubEngineModule],
})
export class EngineModule {}
