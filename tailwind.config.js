/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f6f1ff',
          100: '#ede5ff',
          200: '#d6c7ff',
          300: '#c7b2ff',
          400: '#8750ff',
          500: '#6b35ff',
          600: '#5a2ddd',
          700: '#4a27b8',
        },
        card: '#f9fbff',
        border: '#e2e8f0',
        softGray: '#f7f7f8',
      },
      boxShadow: {
        soft: '0 1px 3px rgba(0,0,0,0.08)',
      },
      fontFamily: {
        sans: ['"Noto Sans JP"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
