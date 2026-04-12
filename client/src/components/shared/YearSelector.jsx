import { FormControl, InputLabel, Select, MenuItem } from '@mui/material';
import { getAcademicYears } from '../../hooks/useAcademicYear';

export default function YearSelector({ value, onChange }) {
  const { current, next } = getAcademicYears();
  const years = [current, next];
  // Also include previous year
  const prevStartYear = current.value - 1;
  years.unshift({
    value: prevStartYear,
    label: `${prevStartYear}-${prevStartYear + 1}`,
    range: `${prevStartYear}-${prevStartYear + 1}`,
  });

  return (
    <FormControl size="small" sx={{ minWidth: 180 }}>
      <InputLabel>שנת לימודים</InputLabel>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        label="שנת לימודים"
      >
        {years.map((y) => (
          <MenuItem key={y.range} value={y.range}>
            {y.label || y.range}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
