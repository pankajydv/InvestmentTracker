/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        profit: '#16a34a',
        loss: '#dc2626',
        primary: '#1e40af',
        'primary-dark': '#1e3a8a',
      },
    },
  },
  plugins: [],
};
