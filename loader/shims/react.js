// Mods may be imported before the app has evaluated React; wait for the shared instance.
while (!globalThis.__clerkSharedModules) await new Promise((r) => setTimeout(r, 16));
const m = globalThis.__clerkSharedModules["react"];
export default m;
export const { Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, Activity, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = m;
