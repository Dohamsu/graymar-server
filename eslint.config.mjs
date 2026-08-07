// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // arch/77 §5 재비대화 래칫 — warn 전용(빌드 비차단).
      // 상한 초과 = 재비대화 신호이므로 **상한을 올리지 말고 분할할 것**.
      //
      // [2026-08-07 재설정 — turns.service 도메인 분할 후]
      //   래칫이 설계대로 발화했고(함수 2,075 / 파일 9,194) 대응은 분할로 했다.
      //   새 최대치: handleLocationTurnInner 1,860 · turns.service 6,864.
      //   - max-lines-per-function 은 2,000 유지 — 내리면 llm-worker
      //     processTurnInner(2,147, arch/77 Phase 4 미착수)가 상시 에러가 되고,
      //     올리는 것은 위 원칙 위반이다. turns.service 여유는 7%.
      //   - max-lines 는 9,000 → 7,900 으로 **조인다**(새 최대치 6,864 + 약 15%).
      //     이전 래칫은 여유가 3%뿐이라 3주를 못 버티고 상시 경고가 됐다 —
      //     상시 경고는 신호를 무디게 만든다(실제로 lint 에러 1건이 묻혔다).
      'max-lines-per-function': [
        'warn',
        { max: 2000, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
      'max-lines': ['warn', { max: 7900, skipBlankLines: false, skipComments: false }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);
