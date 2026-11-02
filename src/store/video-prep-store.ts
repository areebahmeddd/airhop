// Videos being shrunk before they are sent, so the thread can show each one's
// progress and offer to stop it. Written only by services/video-prepare.
//
// Not persisted: a pass dies with the process that ran it, and nothing about
// it has reached the chat yet.

import { create } from "zustand";

export interface VideoPrep {
  id: string;
  // The thread the video is going to.
  channel: string;
  // Waiting behind another video, or being shrunk.
  status: "waiting" | "active";
  // Through the current pass, 0 to 1.
  fraction: number;
}

interface VideoPrepState {
  preps: Record<string, VideoPrep>;
  add: (id: string, channel: string) => void;
  start: (id: string) => void;
  progress: (id: string, fraction: number) => void;
  remove: (id: string) => void;
}

export const useVideoPrepStore = create<VideoPrepState>()((set) => ({
  preps: {},

  add(id, channel) {
    set((state) => ({
      preps: {
        ...state.preps,
        [id]: { id, channel, status: "waiting", fraction: 0 },
      },
    }));
  },

  start(id) {
    set((state) => {
      const prep = state.preps[id];
      if (prep === undefined) return state;
      return {
        preps: {
          ...state.preps,
          [id]: { ...prep, status: "active", fraction: 0 },
        },
      };
    });
  },

  progress(id, fraction) {
    set((state) => {
      const prep = state.preps[id];
      if (prep?.status !== "active") return state;
      return {
        preps: {
          ...state.preps,
          [id]: { ...prep, fraction: Math.min(Math.max(fraction, 0), 1) },
        },
      };
    });
  },

  remove(id) {
    set((state) => {
      if (!(id in state.preps)) return state;
      const next = { ...state.preps };
      delete next[id];
      return { preps: next };
    });
  },
}));
