import { Monitor, Moon, Sun } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { IconButton } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./overlays";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({ preference: "system", setPreference: () => {} });
const STORAGE_KEY = "slai-theme";

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies `data-theme` on <html>. "system" removes it so the OS preference applies via CSS. */
export function applyTheme(p: ThemePreference) {
  const root = document.documentElement;
  if (p === "system") delete root.dataset.theme;
  else root.dataset.theme = p;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setState] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readStored(),
  );
  useEffect(() => applyTheme(preference), [preference]);
  const setPreference = useCallback((p: ThemePreference) => {
    setState(p);
    try {
      if (p === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }, []);
  return <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = preference === "dark" ? Moon : preference === "light" ? Sun : Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Theme" icon={<Icon />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
