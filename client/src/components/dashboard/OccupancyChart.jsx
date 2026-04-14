import { useMemo } from 'react';
import Chart from 'react-apexcharts';

const MONTH_LABELS = [
  'ספט', 'אוק', 'נוב', 'דצמ', 'ינו', 'פבר',
  'מרץ', 'אפר', 'מאי', 'יוני', 'יול', 'אוג',
];

const CLASSROOM_COLORS = {
  'תינוקייה א': '#60a5fa',
  'תינוקייה ב': '#a78bfa',
  'צעירים': '#f472b6',
  'בוגרים': '#34d399',
};

const DEFAULT_COLORS = ['#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c'];

export default function OccupancyChart({ forecast, totalCapacity }) {
  const { options, series } = useMemo(() => {
    if (!forecast || forecast.length === 0) return { options: {}, series: [] };

    // Collect classrooms
    const classrooms = new Set();
    forecast.forEach(f => {
      if (f.byClassroom) Object.keys(f.byClassroom).forEach(c => classrooms.add(c));
      if (f.pendingByClassroom) Object.keys(f.pendingByClassroom).forEach(c => classrooms.add(c));
    });
    const classroomList = Array.from(classrooms);

    const series = [];
    const colors = [];
    const strokeWidths = [];
    const dashArrays = [];

    // Confirmed children per classroom (solid bars)
    classroomList.forEach((cls, i) => {
      series.push({
        name: cls,
        type: 'bar',
        data: forecast.map(f => f.byClassroom?.[cls] || 0),
      });
      colors.push(CLASSROOM_COLORS[cls] || DEFAULT_COLORS[i % DEFAULT_COLORS.length]);
      strokeWidths.push(0);
      dashArrays.push(0);
    });

    // Pending children per classroom (semi-transparent bars on top)
    const hasPending = forecast.some(f =>
      Object.values(f.pendingByClassroom || {}).some(v => v > 0)
    );

    if (hasPending) {
      classroomList.forEach((cls, i) => {
        const pendingData = forecast.map(f => f.pendingByClassroom?.[cls] || 0);
        if (pendingData.some(v => v > 0)) {
          series.push({
            name: `${cls} (ממתין)`,
            type: 'bar',
            data: pendingData,
          });
          const baseColor = CLASSROOM_COLORS[cls] || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
          colors.push(baseColor + '55'); // transparent
          strokeWidths.push(1);
          dashArrays.push(3);
        }
      });
    }

    // Capacity line
    if (totalCapacity > 0) {
      series.push({
        name: `תפוסה מקסימלית (${totalCapacity})`,
        type: 'line',
        data: forecast.map(() => totalCapacity),
      });
      colors.push('#ef4444');
      strokeWidths.push(3);
      dashArrays.push(5);
    }

    // Total annotations on bars
    const totals = forecast.map(f => f.expectedChildren || 0);

    const options = {
      chart: {
        type: 'bar',
        stacked: true,
        height: 380,
        fontFamily: 'Assistant, Heebo, sans-serif',
        toolbar: { show: false },
      },
      plotOptions: {
        bar: { borderRadius: 4, columnWidth: '55%' },
      },
      colors,
      stroke: {
        width: strokeWidths,
        dashArray: dashArrays,
      },
      xaxis: {
        categories: MONTH_LABELS,
        labels: { style: { fontWeight: 600, fontSize: '13px' } },
      },
      yaxis: {
        title: { text: 'ילדים', style: { fontWeight: 700, fontSize: '13px' } },
        min: 0,
        max: totalCapacity > 0
          ? Math.max(totalCapacity + 5, Math.max(...totals) + 5)
          : undefined,
      },
      legend: {
        position: 'bottom',
        horizontalAlign: 'center',
        fontWeight: 600,
        fontSize: '12px',
      },
      dataLabels: {
        enabled: true,
        enabledOnSeries: undefined,
        formatter: (val, { seriesIndex, dataPointIndex, w }) => {
          // Only show total on the TOP of each stacked bar
          const totalSeries = w.config.series.filter(s => s.type === 'bar');
          const isLastBarSeries = seriesIndex === totalSeries.length - 1;
          if (isLastBarSeries && val > 0) {
            return totals[dataPointIndex];
          }
          return '';
        },
        style: { fontSize: '12px', fontWeight: 800, colors: ['#333'] },
        offsetY: -5,
      },
      tooltip: {
        shared: true,
        intersect: false,
        y: {
          formatter: (val) => val > 0 ? `${val} ילדים` : '',
        },
      },
      grid: { borderColor: '#f1f5f9' },
    };

    return { options, series };
  }, [forecast, totalCapacity]);

  if (!forecast || forecast.length === 0) return null;

  return (
    <Chart options={options} series={series} type="line" height={380} />
  );
}
