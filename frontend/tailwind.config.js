/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        military: {
          950: "#111813",
          900: "#182219",
          800: "#263527",
          700: "#3d503d",
        },
      },
    },
  },
  plugins: [],
};
