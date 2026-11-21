/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        paper: '#F3F5F8',
        ink: { DEFAULT: '#0F1B2D', soft: '#4A5568', faint: '#8794A7' },
        line: '#DDE3EB',
        accent: { DEFAULT: '#3347E0', dark: '#2636B8', tint: '#E8EBFC' },
        cache: { DEFAULT: '#0B7A5A', tint: '#E1F4EC' },
        danger: { DEFAULT: '#B42318', tint: '#FDECEA' },
      },
    },
  },
  plugins: [],
};
