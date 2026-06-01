/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#1a1a2e',
        surface: '#16213e',
        accent: '#0f3460',
        highlight: '#e94560',
      }
    }
  },
  plugins: []
}
