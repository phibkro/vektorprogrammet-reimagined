/** Server-only Supabase clients. Never pass the secret key to browser code. */
import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
} from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { getCookies, setCookie } from "@tanstack/react-start/server";
import { Array as Arr, Record as Rec } from "effect";

export interface SupabaseConfig {
  readonly SUPABASE_URL: string;
  readonly SUPABASE_PUBLISHABLE_KEY: string;
  readonly SUPABASE_SECRET_KEY: string;
}

/**
 * Cookie bridge adapted from Supabase Library (Copyright 2024 Supabase, Apache-2.0).
 * Source: https://supabase.com/library/r/supabase-client-tanstack.json
 * License: https://github.com/supabase/supabase/blob/master/LICENSE
 * Modified for explicit Worker bindings and a separate raw-Worker cookie adapter.
 */
export const createRequestClient = (config: SupabaseConfig) =>
  createServerClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () =>
        Arr.map(Rec.toEntries(getCookies()), ([name, value]) => ({
          name,
          value,
        })),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) {
          setCookie(name, value, options);
        }
      },
    },
  });

/** For Worker routes outside TanStack's request context, collect cookies for the response. */
export const createWorkerClient = (
  config: SupabaseConfig,
  request: Request,
  responseHeaders: Headers
) => {
  const cookies = new Map(
    Arr.map(
      parseCookieHeader(request.headers.get("cookie") ?? ""),
      ({ name, value }) => [name, value] as const
    )
  );

  return createServerClient(
    config.SUPABASE_URL,
    config.SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () =>
          Arr.map(Arr.fromIterable(cookies), ([name, value]) => ({
            name,
            value,
          })),
        setAll: (updates) => {
          for (const { name, value, options } of updates) {
            cookies.set(name, value);
            responseHeaders.append(
              "set-cookie",
              serializeCookieHeader(name, value, options)
            );
          }
        },
      },
    }
  );
};

/** Service-role client for trusted server operations such as Storage. */
export const createAdminClient = (config: SupabaseConfig) =>
  createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
