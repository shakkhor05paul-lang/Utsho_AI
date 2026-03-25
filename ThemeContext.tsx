
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { ThemeName, Theme, themes, applyTheme, getStoredTheme, storeTheme } from './themes';

interface ThemeContextValue {
  currentTheme: ThemeName;
  theme: Theme;
  setTheme: (name: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  currentTheme: 'midnight',
  theme: themes.midnight,
  setTheme: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentTheme, setCurrentTheme] = useState<ThemeName>(getStoredTheme);

  const theme = themes[currentTheme];

  const setTheme = useCallback((name: ThemeName) => {
    setCurrentTheme(name);
    storeTheme(name);
    applyTheme(themes[name]);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, []);

  return (
    <ThemeContext.Provider value={{ currentTheme, theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};
