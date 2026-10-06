import reactHooks from 'eslint-plugin-react-hooks';
import base from '../../eslint.config.js';

export default [
  ...base,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
];
