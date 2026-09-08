import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "./supabase";
import { useAuth } from "../auth/AuthProvider";

/**
 * One shared source of truth for which activities the signed-in parent has
 * favourited.
 *
 * Every heart on every card used to run its own
 * `select … from favorites where activity_id = ?` on mount (see the old
 * `useFavorite`). A full Explore list renders up to 500 cards, so that was up
 * to 500 round trips fired at once on every visit — and, with no client
 * router, every navigation is a fresh visit. This fetches the id set once per
 * session and hands it down; `useFavorite` reads from here.
 */
interface FavoritesStore {
  /** The first fetch has answered (or there is no session). */
  ready: boolean;
  isFavorited: (activityId: string) => boolean;
  /** Reflect a just-completed toggle locally, without a refetch. */
  setFavorited: (activityId: string, favorited: boolean) => void;
}

const FavoritesCtx = createContext<FavoritesStore | null>(null);

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!session) {
      setIds(new Set());
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    supabase
      .from("favorites")
      .select("activity_id")
      .eq("user_id", session.user.id)
      .then(({ data }) => {
        if (cancelled) return;
        setIds(new Set((data ?? []).map((r) => r.activity_id as string)));
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const value = useMemo<FavoritesStore>(
    () => ({
      ready,
      isFavorited: (activityId) => ids.has(activityId),
      setFavorited: (activityId, favorited) =>
        setIds((prev) => {
          if (prev.has(activityId) === favorited) return prev;
          const next = new Set(prev);
          if (favorited) next.add(activityId);
          else next.delete(activityId);
          return next;
        }),
    }),
    [ready, ids]
  );

  return <FavoritesCtx.Provider value={value}>{children}</FavoritesCtx.Provider>;
}

/** Accessor for the store. Falls back to an inert store when no provider is
 *  mounted, so a heart rendered in isolation never throws. */
export function useFavoritesStore(): FavoritesStore {
  const ctx = useContext(FavoritesCtx);
  return (
    ctx ?? {
      ready: false,
      isFavorited: () => false,
      setFavorited: () => {},
    }
  );
}
