import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['demo/**/*.mjs', 'scripts/**/*.mjs'], languageOptions: { globals: {
    fetch: 'readonly', process: 'readonly', AbortSignal: 'readonly',
    setTimeout: 'readonly', setInterval: 'readonly',
  } } },
  { ignores: ['dist/**', 'coverage/**'] },
);
