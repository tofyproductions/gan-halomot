import { Outlet } from 'react-router-dom';
import { Box } from '@mui/material';
import Header from './Header';
import { useBranch } from '../../hooks/useBranch';

/**
 * Branch → subtle background tint. The tint is very light so text remains
 * readable. Falls back to the default slate if no branch matched.
 */
const BRANCH_TINTS = {
  'כפר סבא - קפלן':     { bg: '#fdf2f8', tint: 'rgba(236,72,153,0.04)' },   // pink
  'כפר סבא - משה דיין':  { bg: '#fff7ed', tint: 'rgba(251,146,60,0.04)' },    // orange
  'תל אביב':             { bg: '#f0f9ff', tint: 'rgba(56,189,248,0.04)' },     // cyan
  'הרצליה הרצוג':        { bg: '#fefce8', tint: 'rgba(250,204,21,0.04)' },     // yellow
};
const DEFAULT_BG = '#f8fafc';

/**
 * Gentle floating clouds via CSS keyframes. The clouds are purely decorative
 * white ellipses that drift slowly across the viewport. They sit behind all
 * content (z-index: 0) and have very low opacity so they never interfere
 * with readability.
 */
const cloudKeyframes = `
@keyframes drift1 {
  0%   { transform: translateX(-20vw) translateY(0); }
  100% { transform: translateX(110vw) translateY(-8vh); }
}
@keyframes drift2 {
  0%   { transform: translateX(110vw) translateY(0); }
  100% { transform: translateX(-20vw) translateY(6vh); }
}
@keyframes drift3 {
  0%   { transform: translateX(-30vw) translateY(0); }
  100% { transform: translateX(120vw) translateY(-4vh); }
}
`;

const cloudStyle = (top, size, duration, delay, anim) => ({
  position: 'fixed',
  top,
  width: size,
  height: `calc(${size} * 0.4)`,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.55)',
  filter: 'blur(30px)',
  animation: `${anim} ${duration}s linear ${delay}s infinite`,
  pointerEvents: 'none',
  zIndex: 0,
});

export default function Layout() {
  const { selectedBranchName } = useBranch();
  const palette = BRANCH_TINTS[selectedBranchName] || { bg: DEFAULT_BG, tint: 'transparent' };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: palette.bg, position: 'relative', overflow: 'hidden' }}>
      {/* Inject keyframes */}
      <style>{cloudKeyframes}</style>

      {/* Decorative clouds */}
      <Box sx={cloudStyle('12vh', '260px', 45, 0, 'drift1')} />
      <Box sx={cloudStyle('35vh', '340px', 60, 8, 'drift2')} />
      <Box sx={cloudStyle('65vh', '200px', 50, 15, 'drift3')} />
      <Box sx={cloudStyle('80vh', '280px', 55, 25, 'drift1')} />

      <Box sx={{ position: 'relative', zIndex: 1 }}>
        <Header />
        <Box sx={{ maxWidth: 1200, mx: 'auto', px: { xs: 1, sm: 2 }, py: { xs: 1.5, sm: 3 } }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}
