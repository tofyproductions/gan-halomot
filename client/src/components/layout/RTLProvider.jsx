import { CacheProvider } from '@emotion/react';
import { ThemeProvider, CssBaseline } from '@mui/material';
import newTheme, { cacheRtl } from '../../theme/rtlTheme';
import classicTheme, { cacheRtlClassic } from '../../theme/classicTheme';
import { useUiVersion } from '../../hooks/useUiVersion';

/**
 * The theme, chosen per person.
 *
 * Two complete themes are shipped side by side — the one the gans have been
 * using and the redesign — and which one renders is `User.ui_version`, the
 * person's own answer. Nobody is moved by a deploy.
 *
 * Each theme carries its OWN emotion cache, with its own key ('muirtl' and
 * 'muirtlclassic'). One shared cache would let class names generated under one
 * theme be reused under the other, so switching would leave a screen wearing
 * half of each. Separate keys make the two sets of styles unable to collide.
 */
export default function RTLProvider({ children }) {
  const { isNew } = useUiVersion();
  const cache = isNew ? cacheRtl : cacheRtlClassic;
  const theme = isNew ? newTheme : classicTheme;

  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
