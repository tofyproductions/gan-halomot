import { useMemo } from 'react';
import Chart from 'react-apexcharts';

const MONTH_LABELS = [
  'ספט', 'אוק', 'נוב', 'דצמ', 'ינו', 'פבר',
  'מרץ', 'אפר', 'מאי', 'יוני', 'יול', 'אוג',
];

const CLASSROOM_COLORS = {
  'תינוקייה א': '#60a5fa', // blue
  'תינוקייה ב': '#a78bfa', // purple
  'צעירים': '#f472b6',     // pink
  'בוגרים': '#34d399',     // green
};

const DEFAULT_COLORS = ['#60a5fa', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c'];

export default function OccupancyChart({ forecast, totalCapacity }) {
  const { options, series } = useMemo(() => {
    if (!forecast || forecast.length === 0) return { options: {}, series: [] };

    // Extract unique classrooms from forecast data
    const classrooms = new Set();
    forecast.forEach(f => {
      if (f.byClassroom) {
        Object.keys(f.byClassroom).forEach(c => classrooms.add(c));
      }
    });

    const classroomList = Array.from(classrooms);

    // Build stacked bar series - one per classroom
    const series = classroomList.map((cls, idx) => ({
      name: cls,
      type: 'bar',
      data: forecast.map(f => f.byClassroom?.[cls] || 0),
    }));

    // Add capacity line if available
    if (totalCapacity > 0) {
      series.push({
        name: `תפוסה מקסימלית (${totalCapacity})`,
        type: 'line',
        data: forecast.map(() => totalCapacity),
      });
    }

    // Colors
    const colors = classroomList.map((cls, i) =>
      CLASSROOM_COLORS[cls] || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
    );
    if (totalCapacity > 0) colors.push('#ef4444'); // red for capacity line

    const strokeWidths = classroomList.map(() => 0);
    const dashArrays = classroomList.map(() => 0);
    if (totalCapacity > 0) {
      strokeWidths.push(3);
      dashArrays.push(5);
    }

    const options = {
      chart: {
        type: 'bar',
        stacked: true,
        height: 380,
        fontFamily: 'Assistant, Heebo, sans-serif',
        toolbar: { show: false },
      },
      plotOptions: {
        bar: {
          borderRadius: 4,
          columnWidth: '55%',
        },
      },
      colors,
      stroke: {
        width: strokeWidths,
        dashArray: dashArrays,
      },
      xaxis: {
        categories: MONTH_LABELS,
        labels: {
          style: { fontWeight: 600, fontSize: '13px' },
        },
      },
      yaxis: {
        title: { text: 'ילדים רשומים', style: { fontWeight: 700, fontSize: '13px' } },
        min: 0,
        max: totalCapacity > 0 ? Math.max(totalCapacity + 5, Math.max(...forecast.map(f => f.expectedChildren)) + 5) : undefined,
      },
      legend: {
        position: 'bottom',
        horizontalAlign: 'center',
        fontWeight: 600,
        fontSize: '13px',
        markers: { radius: 4 },
      },
      dataLabels: {
        enabled: false,
      },
      tooltip: {
        shared: true,
        intersect: false,
        y: {
          formatter: (val) => val > 0 ? `${val} ילדים` : '',
        },
      },
      grid: {
        borderColor: '#f1f5f9',
      },
    };

    return { options, series };
  }, [forecast, totalCapacity]);

  if (!forecast || forecast.length === 0) return null;

  return (
    <Chart
      options={options}
      series={series}
      type="line"
      height={380}
    />
  );
}
