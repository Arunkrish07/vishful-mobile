import React, { createContext, useContext } from 'react';
import { lightColors } from './theme';

interface ThemeContextType {
  isDark: false;
  colors: typeof lightColors;
}

const ThemeContext = createContext<ThemeContextType>({
  isDark: false,
  colors: lightColors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeContext.Provider value={{ isDark: false, colors: lightColors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);