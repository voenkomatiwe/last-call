"use client";

import { useCallback, useEffect, useState } from "react";

// The bar's sound settings, remembered per browser (a convenience only: storage may be blocked).

const SOUND_KEY = "last-call:bar-sound";
const BODY_KEY = "last-call:bar-body";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    // a remembered toggle is a convenience only
  }
}

export interface BarSettings {
  readonly sound: boolean;
  /** Burps and farts. */
  readonly bodySounds: boolean;
  readonly setSound: (on: boolean) => void;
  readonly setBodySounds: (on: boolean) => void;
}

export function useBarSettings(): BarSettings {
  const [sound, setSoundState] = useState(true);
  const [bodySounds, setBodyState] = useState(true);
  useEffect(() => {
    setSoundState(readFlag(SOUND_KEY));
    setBodyState(readFlag(BODY_KEY));
  }, []);
  const setSound = useCallback((on: boolean) => {
    setSoundState(on);
    writeFlag(SOUND_KEY, on);
  }, []);
  const setBodySounds = useCallback((on: boolean) => {
    setBodyState(on);
    writeFlag(BODY_KEY, on);
  }, []);
  return { sound, bodySounds, setSound, setBodySounds };
}
