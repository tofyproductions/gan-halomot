import { useMemo } from 'react';
import Chart from 'react-apexcharts';

const MONTH_LABELS = [
  'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳', 'ינו׳', 'פבר׳',
  'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳',
];

export default function OccupancyChart({ forecast, classroomCapacity }) {
  const { options, series } = useMemo(() => {
    // Total capacity across all classrooms
    const totalCapacity = classroomCapacity.reduce((sum, c) => sum + (c.capacity || 0), 0);

    // Children per month from forecast
    const childrenPerMonth = forecast.map(f => f.expectedChildren);

    const series = [
      {
        name: 'ילדים רשומים',
        type: 'bar',
        data: childrenPerMonth,
      },
    ];

    // Add capacity line if available
    if (totalCapacity > 0) {
      series.push({
        name: `תפוסה מקסימלית (${totalCapacity})`,
        type: 'line',
        data: forecast.map(() => totalCapacity),
      });
    }

    const options = {
      chart: {
        type: 'line',
        height: 320,
        fontFamily: 'Assistant, Heebo, sans-serif',
        toolbar: { show: false },
        dir: 'rtl',
      },
      plotOptions: {
        bar: {
          borderRadius: 6,
          columnWidth: '50%',
        },
      },
      colors: ['#f59e0b', '#ef4444'],
      stroke: {
        width: [0, 3],
        dashArray: [0, 5],
      },
      fill: {
        opacity: [0.9, 1],
      },
      xaxis: {
        categories: MONTH_LABELS,
        labels: {
          style: { fontWeight: 600, fontSize: '12px' },
        },
      },
      yaxis: {
        title: { text: 'מספר ילדים', style: { fontWeight: 700 } },
        min: 0,
      },
      legend: {
        position: 'top',
        horizontalAlign: 'right',
        fontWeight: 600,
      },
      dataLabels: {
        enabled: true,
        enabledOnSeries: [0],
        style: { fontSize: '11px', fontWeight: 700 },
      },
      tooltip: {
        shared: true,
        intersect: false,
      },
    };

    return { options, series };
  }, [forecast, classroomCapacity]);

  return (
    <Chart
      options={options}
      series={series}
      type="line"
      height={320}
    />
  );
}
