/**
 * CreateRunBodySchema 검증 단위 테스트
 *
 * 회귀 방지: 보너스 스탯이 미배분(합계 ≠ 6) 상태로 들어오면
 * zod parse가 실패해야 하고, 컨트롤러는 ZodValidationPipe를 통해
 * InvalidInputError(422)로 변환한다. 과거에는 컨트롤러에서 parse를
 * 직접 호출해 ZodError가 catch-all로 빠져 500이 나왔다.
 */
import { CreateRunBodySchema } from './create-run.dto.js';

describe('CreateRunBodySchema', () => {
  describe('bonusStats 합계 검증', () => {
    it('합계 6이면 통과한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        gender: 'male',
        characterName: '검증자',
        bonusStats: { str: 1, dex: 1, wit: 1, con: 1, per: 1, cha: 1 },
        traitId: 'STREET_SENSE',
      });
      expect(result.success).toBe(true);
    });

    it('합계 5(cha 누락)는 zod 검증 실패한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        gender: 'male',
        characterName: '검증자2',
        bonusStats: { str: 1, dex: 1, wit: 1, con: 1, per: 1 },
        traitId: 'STREET_SENSE',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.stringContaining('bonusStats 합계는 정확히 6'),
          ]),
        );
      }
    });

    it('합계 0(모든 키 0)도 검증 실패한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        bonusStats: { str: 0, dex: 0, wit: 0, con: 0, per: 0, cha: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('합계 7(과배분)도 검증 실패한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        bonusStats: { str: 2, dex: 2, wit: 1, con: 1, per: 1, cha: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('단일 키 6 (str=6) 합계도 통과한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        bonusStats: { str: 6, dex: 0, wit: 0, con: 0, per: 0, cha: 0 },
      });
      expect(result.success).toBe(true);
    });

    it('bonusStats 자체가 생략되면 통과한다 (보너스 미배분 = 합계 검증 skip)', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        gender: 'male',
      });
      expect(result.success).toBe(true);
    });

    it('각 키가 6 초과면 검증 실패한다', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        bonusStats: { str: 7, dex: 0, wit: 0, con: 0, per: 0, cha: 0 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('characterName 검증', () => {
    it('한글 1~8자 이름 통과', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        characterName: '검증자',
      });
      expect(result.success).toBe(true);
    });

    it('숫자 포함 이름은 거부', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        characterName: '검증자123',
      });
      expect(result.success).toBe(false);
    });

    it('9자 이상은 거부', () => {
      const result = CreateRunBodySchema.safeParse({
        presetId: 'DESERTER',
        characterName: '아주아주아주아주긴',
      });
      expect(result.success).toBe(false);
    });
  });
});
