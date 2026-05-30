import { createContext, useContext } from "react";
import type { CanonicalStack } from "./deployments.js";

// Stack context: the current deployment handles + a setter to swap.
// Lives at the App root so any tab can read or override.

export interface StackContextValue {
  stack: CanonicalStack;
  replace: (next: CanonicalStack) => void;
}

export const StackContext = createContext<StackContextValue | null>(null);

export function useStack(): StackContextValue {
  const v = useContext(StackContext);
  if (!v) throw new Error("StackContext not mounted");
  return v;
}
