/** @type {import('tailwindcss').Config} */

/**
 * UI-0 — Team Balance Pro design tokens (approved Lovable visual language,
 * translated to Tailwind 3). Every color is an oklch CSS variable defined in
 * src/app/globals.css (`--tbp-*`, channel values only) so Tailwind's opacity
 * modifiers work (e.g. `bg-primary/90`).
 *
 * Everything here is ADDITIVE and OPT-IN: new color names, `tbp-*` radii,
 * `card`/`lift` shadows and `display`/`body` font families. Tailwind's
 * defaults (`rounded-*`, `font-sans`, the gray/emerald palettes, …) are NOT
 * overridden, so existing pages render exactly as before.
 */
const tbp = (name) => `oklch(var(--tbp-${name}) / <alpha-value>)`;

module.exports = {
  content: ['./src/app/**/*.{js,ts,jsx,tsx}', './src/components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: tbp('background'),
        foreground: tbp('foreground'),
        card: { DEFAULT: tbp('card'), foreground: tbp('card-foreground') },
        primary: { DEFAULT: tbp('primary'), foreground: tbp('primary-foreground') },
        secondary: { DEFAULT: tbp('secondary'), foreground: tbp('secondary-foreground') },
        muted: { DEFAULT: tbp('muted'), foreground: tbp('muted-foreground') },
        accent: { DEFAULT: tbp('accent'), foreground: tbp('accent-foreground') },
        destructive: { DEFAULT: tbp('destructive'), foreground: tbp('destructive-foreground') },
        border: tbp('border'),
        input: tbp('input'),
        ring: tbp('ring'),
        pitch: { DEFAULT: tbp('pitch'), foreground: tbp('pitch-foreground') },
        'team-a': tbp('team-a'),
        'team-b': tbp('team-b'),
      },
      borderRadius: {
        'tbp-sm': 'calc(var(--tbp-radius) - 4px)',
        'tbp-md': 'calc(var(--tbp-radius) - 2px)',
        tbp: 'var(--tbp-radius)',
        'tbp-xl': 'calc(var(--tbp-radius) + 4px)',
        'tbp-2xl': 'calc(var(--tbp-radius) + 8px)',
      },
      boxShadow: {
        card: 'var(--tbp-shadow-card)',
        lift: 'var(--tbp-shadow-lift)',
      },
      fontFamily: {
        display: ['var(--font-tbp-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['var(--font-tbp-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
