import { useState } from 'react';
import { Box, Typography, Button, Menu, MenuItem, ListItemIcon, Divider, Tooltip } from '@mui/material';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

/**
 * The top of a screen: what you are looking at, and the one thing to do about it.
 *
 * The shape it replaces, on רישום חיצוני, was two rows carrying six buttons —
 * two of them filled and competing for the same attention, two of them red and
 * destructive, sitting a few pixels from the ones you press every day — plus a
 * branch dropdown and a year chip wedged into the title line. Nothing on it
 * said which action was the normal one, and the two most dangerous buttons on
 * the page were the easiest to hit by accident.
 *
 * Here there is exactly one filled button. Everything else is quieter than it,
 * and anything destructive is behind the overflow menu, which is not
 * ceremony — it is the difference between "מחיקת קובץ" being one careless
 * click away and being two deliberate ones.
 *
 * `meta` is the context that used to be controls: the branch, the year, the
 * state of the last file. It is prose, because that is what it is.
 */
export default function PageHeader({
  title,
  meta = [],
  primary,
  actions = [],
  menu = [],
  children,
}) {
  const [anchor, setAnchor] = useState(null);
  const visibleMenu = menu.filter(Boolean);
  const visibleActions = actions.filter(Boolean);

  return (
    <Box sx={{ mb: 2.5 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 2,
          flexWrap: 'wrap',
          pb: 1.75,
          mb: children ? 1.75 : 0,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
          <Typography
            component="h1"
            sx={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.015em', lineHeight: 1.2 }}
          >
            {title}
          </Typography>

          {meta.length > 0 && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 0.75,
                mt: 0.5,
                fontSize: '0.8125rem',
                color: 'text.secondary',
              }}
            >
              {meta.filter(Boolean).map((m, i) => (
                <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  {i > 0 && <Box component="span" sx={{ color: 'text.disabled' }}>·</Box>}
                  <Box component="span" sx={{ color: m.strong ? 'text.primary' : 'inherit', fontWeight: m.strong ? 600 : 400 }}>
                    {m.label ?? m}
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
          {visibleActions.map((a) => (
            <Tooltip key={a.label} title={a.hint || ''} disableHoverListener={!a.hint}>
              <span>
                <Button
                  variant={a.variant || 'outlined'}
                  color={a.color || 'inherit'}
                  startIcon={a.icon}
                  onClick={a.onClick}
                  disabled={a.disabled}
                >
                  {a.label}
                </Button>
              </span>
            </Tooltip>
          ))}

          {primary && (
            <Tooltip title={primary.hint || ''} disableHoverListener={!primary.hint}>
              <span>
                <Button
                  variant="contained"
                  startIcon={primary.icon}
                  onClick={primary.onClick}
                  disabled={primary.disabled}
                >
                  {primary.label}
                </Button>
              </span>
            </Tooltip>
          )}

          {visibleMenu.length > 0 && (
            <>
              <Button
                onClick={(e) => setAnchor(e.currentTarget)}
                aria-label="פעולות נוספות"
                variant="outlined"
                sx={{ minWidth: 40, px: 1 }}
              >
                <MoreHorizIcon fontSize="small" />
              </Button>
              <Menu
                anchorEl={anchor}
                open={!!anchor}
                onClose={() => setAnchor(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                transformOrigin={{ vertical: 'top', horizontal: 'left' }}
              >
                {visibleMenu.map((m, i) => [
                  // A rule above the destructive block. The only thing keeping
                  // "delete the file" apart from "export to Excel" used to be
                  // that one was red.
                  m.danger && !visibleMenu[i - 1]?.danger && i > 0
                    ? <Divider key={`d${i}`} sx={{ my: 0.5 }} />
                    : null,
                  <MenuItem
                    key={m.label}
                    onClick={() => { setAnchor(null); m.onClick?.(); }}
                    disabled={m.disabled}
                    sx={{ fontSize: '0.875rem', color: m.danger ? 'error.main' : 'inherit', py: 0.875 }}
                  >
                    {m.icon && (
                      <ListItemIcon sx={{ minWidth: 32, color: m.danger ? 'error.main' : 'text.secondary' }}>
                        {m.icon}
                      </ListItemIcon>
                    )}
                    {m.label}
                  </MenuItem>,
                ])}
              </Menu>
            </>
          )}
        </Box>
      </Box>

      {children}
    </Box>
  );
}
