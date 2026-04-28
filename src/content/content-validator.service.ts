/**
 * ContentValidatorService — architecture/49 Phase 4.
 *
 * 콘텐츠(NPC/Fact/Location) 정합성을 빌드 시점에 자동 검증.
 * 누적된 콘텐츠 입력 오류(speechRegister vs style 불일치, roleKeywords 누락 등)를
 * NPA가 사후 검출하기 전에 사전 차단.
 *
 * 검증 대상:
 *  - NPC.personality.speechRegister vs speechStyle 텍스트 패턴 일치
 *  - NPC.tier === 'CORE' && roleKeywords 미정의
 *  - NPC.unknownAlias 부분 단어가 일반 형용사 (RISKY_FRAGMENTS)
 *
 * 출력:
 *  - WARNING/INFO 레벨로 logger.warn/log 출력
 *  - 빌드 실패는 안 함 (콘텐츠 점진 정정용)
 */

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { NpcDefinition } from './content.types.js';
import { ContentLoaderService } from './content-loader.service.js';

export type ContentValidationSeverity = 'WARNING' | 'INFO';

export interface ContentValidationResult {
  severity: ContentValidationSeverity;
  rule: string;
  message: string;
  npcId?: string;
}

const RISKY_FRAGMENTS = new Set([
  '젊은',
  '늙은',
  '냄새가',
  '강한',
  '약한',
  '큰',
  '작은',
  '조용한',
  '시끄러운',
  '빠른',
  '느린',
  '뜨거운',
  '차가운',
  '날카로운',
  '풋풋한',
  '투박한',
  '거친',
  '부드러운',
  '다정한',
  '향수',
]);

@Injectable()
export class ContentValidatorService implements OnModuleInit {
  private readonly logger = new Logger(ContentValidatorService.name);

  constructor(private readonly content: ContentLoaderService) {}

  /**
   * NestJS lifecycle — ContentLoader.onModuleInit 이후 자동 실행.
   */
  onModuleInit(): void {
    this.validateAll();
  }

  /**
   * 모든 NPC 검증 후 결과 반환 + 로깅.
   */
  validateAll(): ContentValidationResult[] {
    const results: ContentValidationResult[] = [];
    const npcs = this.content.getAllNpcs();

    for (const npc of npcs) {
      results.push(...this.validateRegisterStyle(npc));
      results.push(...this.validateRoleKeywords(npc));
      results.push(...this.validateAliasFragments(npc));
    }

    this.logResults(results);
    return results;
  }

  /**
   * speechRegister 등록값과 speechStyle 텍스트 패턴 일치 검증.
   * 텍스트에 ~소/~하오/~이오 패턴 → HAOCHE 추론.
   * 텍스트에 ~습니다/~입니다 패턴 → HAPSYO 추론.
   */
  private validateRegisterStyle(npc: NpcDefinition): ContentValidationResult[] {
    const style = npc.personality?.speechStyle;
    const register = npc.personality?.speechRegister;
    if (!style || !register) return [];
    const inferred = this.inferRegisterFromStyle(style);
    if (inferred && inferred !== register) {
      return [
        {
          severity: 'WARNING',
          rule: 'REGISTER_STYLE_MISMATCH',
          message: `${npc.npcId}(${npc.name}): register=${register}이지만 speechStyle 텍스트는 ${inferred} 패턴`,
          npcId: npc.npcId,
        },
      ];
    }
    return [];
  }

  /**
   * CORE NPC에 명시 roleKeywords가 없으면 WARNING (사용자 자유 호명 매칭 부재).
   */
  private validateRoleKeywords(npc: NpcDefinition): ContentValidationResult[] {
    if (npc.tier !== 'CORE') return [];
    if (npc.roleKeywords && npc.roleKeywords.length > 0) return [];
    return [
      {
        severity: 'WARNING',
        rule: 'CORE_NO_ROLE_KEYWORDS',
        message: `${npc.npcId}(${npc.name}): CORE NPC에 roleKeywords 미정의 — 자유 호명 매칭 불가`,
        npcId: npc.npcId,
      },
    ];
  }

  /**
   * unknownAlias의 부분 단어가 RISKY_FRAGMENTS 포함 시 INFO.
   * 매칭 false positive 가능성 알림 (실제 매칭은 NpcResolverService에서 차단됨).
   */
  private validateAliasFragments(
    npc: NpcDefinition,
  ): ContentValidationResult[] {
    const alias = npc.unknownAlias;
    if (!alias) return [];
    const fragments = alias.split(/\s+/);
    const risky = fragments.filter((f) => RISKY_FRAGMENTS.has(f));
    if (risky.length === 0) return [];
    return [
      {
        severity: 'INFO',
        rule: 'ALIAS_RISKY_FRAGMENT',
        message: `${npc.npcId}(${npc.name}) alias "${alias}"에 일반 형용사 [${risky.join(',')}] 포함 — false positive 가능 (resolver가 차단)`,
        npcId: npc.npcId,
      },
    ];
  }

  /**
   * speechStyle 텍스트에서 어체 추론.
   */
  private inferRegisterFromStyle(style: string): string | null {
    const text = style.toLowerCase();
    // HAOCHE 신호 우선 (가장 많은 NPC가 사용)
    if (/~소|~하오|~이오|~구려|~구먼|~다네|~라네/.test(text)) return 'HAOCHE';
    if (/~습니다|~입니다|~십시오/.test(text)) return 'HAPSYO';
    if (/~해요|~예요|~네요|~거든요/.test(text)) return 'HAEYO';
    if (/~한다\b|~했다\b|~다\b/.test(text) && !/~다네|~라네/.test(text))
      return 'HAECHE';
    if (/반말|~해\b|~야\b|~지\b/.test(text)) return 'BANMAL';
    return null;
  }

  /**
   * 검증 결과를 logger.warn/log로 출력.
   */
  private logResults(results: ContentValidationResult[]): void {
    const warnings = results.filter((r) => r.severity === 'WARNING');
    const infos = results.filter((r) => r.severity === 'INFO');
    if (warnings.length === 0 && infos.length === 0) {
      this.logger.log('[ContentValidator] 모든 NPC 콘텐츠 정합성 OK');
      return;
    }
    this.logger.log(
      `[ContentValidator] ${warnings.length} WARNING + ${infos.length} INFO`,
    );
    for (const w of warnings) {
      this.logger.warn(`  ⚠️ [${w.rule}] ${w.message}`);
    }
    for (const i of infos.slice(0, 5)) {
      this.logger.log(`  ℹ️ [${i.rule}] ${i.message}`);
    }
    if (infos.length > 5) {
      this.logger.log(`  ... + ${infos.length - 5} INFO`);
    }
  }
}
