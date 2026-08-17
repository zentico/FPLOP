/**
 * FPLOP brand tokens, synced from the web artifact (artifacts/fpl-optimizer/src/index.css).
 * Light: deep purple primary (#38003C), vivid green accent (#00FF85), pink destructive (#FF2882).
 * Dark: deep purple surfaces with green as the primary action colour.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#1A1023',
    tint: '#38003C',

    background: '#F8F8FA',
    foreground: '#1A1023',

    card: '#FFFFFF',
    cardForeground: '#1A1023',

    primary: '#38003C',
    primaryForeground: '#FFFFFF',

    secondary: '#F1EAF2',
    secondaryForeground: '#38003C',

    muted: '#EFEFF2',
    mutedForeground: '#6E6A75',

    accent: '#00E67A',
    accentForeground: '#062B18',

    destructive: '#FF2882',
    destructiveForeground: '#FFFFFF',

    border: '#E6E3EA',
    input: '#E6E3EA',
  },

  dark: {
    text: '#F5EFF6',
    tint: '#00FF85',

    background: '#23001F',
    foreground: '#F5EFF6',

    card: '#38003C',
    cardForeground: '#F5EFF6',

    primary: '#00FF85',
    primaryForeground: '#12001A',

    secondary: '#4A1350',
    secondaryForeground: '#F5EFF6',

    muted: '#43104A',
    mutedForeground: '#BBA3C0',

    accent: '#00FF85',
    accentForeground: '#062B18',

    destructive: '#FF2882',
    destructiveForeground: '#FFFFFF',

    border: '#4D1A54',
    input: '#4D1A54',
  },

  radius: 8,
};

export default colors;
