import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/** Whether the viewport is narrower than the `md` breakpoint; false until the first effect has measured it. */
export const useIsMobile = (): boolean => {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>();

  React.useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    const measure = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    query.addEventListener("change", measure);
    measure();

    return () => {
      query.removeEventListener("change", measure);
    };
  }, []);

  return isMobile === true;
};
