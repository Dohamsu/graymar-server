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
      // arch/77 §5 재비대화 래칫 — 현재 최대치(함수 1,937줄 / 파일 8,598줄) 직상 상한.
      // warn 전용(빌드 비차단). 상한 초과 = 재비대화 신호이므로 상한을 올리지 말고 분할할 것.
      'max-lines-per-function': [
        'warn',
        { max: 2000, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
      'max-lines': ['warn', { max: 9000, skipBlankLines: false, skipComments: false }],
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
