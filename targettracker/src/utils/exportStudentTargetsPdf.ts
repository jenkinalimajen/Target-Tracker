import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { groupTargetsHierarchically, TargetFontColor } from '../types';

export interface ExportableTargetItem {
  heading?: string;
  title: string;
  challenge?: string;
  suggestedStrategies?: string;
  fontColor?: TargetFontColor | string;
  targetGroupId?: string;
}

export interface ExportStudentTargetsPdfParams {
  studentName: string;
  yearGroup: string;
  term: string;
  teacherName?: string;
  subject?: string;
  targets: ExportableTargetItem[];
}

const ROW_FILL_PALETTE: Array<[number, number, number]> = [
  [191, 219, 254], // Bright Light Blue
  [167, 243, 208], // Bright Mint Green
  [253, 230, 138], // Bright Warm Yellow-Amber
  [221, 214, 254], // Bright Lavender
  [254, 205, 211], // Bright Coral Rose
  [165, 243, 252], // Bright Aqua Cyan
];

function wrapTextPreservingNewlines(
  pdf: jsPDF,
  text: string,
  maxW: number,
  fontStyle: 'normal' | 'bold',
  fontSize: number
): string[] {
  pdf.setFont('helvetica', fontStyle);
  pdf.setFontSize(fontSize);
  const rawLines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  for (const raw of rawLines) {
    if (raw.length === 0) {
      result.push('');
    } else {
      const wrapped = pdf.splitTextToSize(raw, maxW) as string[];
      if (wrapped.length === 0) {
        result.push('');
      } else {
        result.push(...wrapped);
      }
    }
  }
  return result;
}

interface PlannedRow {
  col0Lines: string[];
  descLines: string[];
  challengeLines: string[];
  stratLines: string[];
  rowFillColor: [number, number, number];
  rowHeight: number;
}

export function exportStudentTargetsPdf({
  studentName,
  yearGroup,
  term,
  targets,
}: ExportStudentTargetsPdfParams): void {
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const margin = 10;
  const usableWidth = 190; // 210mm - 20mm margins
  const pageHeight = 297;

  const cleanStudent = (studentName || 'Student').trim();
  const cleanYear = (yearGroup || 'Year').trim();
  const cleanTerm = (term || 'TERM 1').trim();

  // 1. Header Block:
  // Row 1: W3 IEP Targets | Teacher Name | Subject
  // Row 2: Student Name   | Year         | Term
  autoTable(pdf, {
    startY: 12,
    margin: { left: margin, right: margin },
    tableWidth: usableWidth,
    body: [
      [
        {
          content: 'W3 IEP Targets',
          styles: {
            fontStyle: 'bold',
            fontSize: 11.5,
            fillColor: [241, 245, 249],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
        {
          content: 'Teacher Name:',
          styles: {
            fontStyle: 'bold',
            fontSize: 9,
            fillColor: [241, 245, 249],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
        {
          content: 'Subject:',
          styles: {
            fontStyle: 'bold',
            fontSize: 9,
            fillColor: [241, 245, 249],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
      ],
      [
        {
          content: `Student Name: ${cleanStudent}`,
          styles: {
            fontStyle: 'bold',
            fontSize: 9,
            fillColor: [255, 255, 255],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
        {
          content: `Year: ${cleanYear}`,
          styles: {
            fontStyle: 'bold',
            fontSize: 9,
            fillColor: [255, 255, 255],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
        {
          content: `Term: ${cleanTerm}`,
          styles: {
            fontStyle: 'bold',
            fontSize: 9,
            fillColor: [255, 255, 255],
            textColor: [0, 0, 0],
            valign: 'middle',
          },
        },
      ],
    ],
    columnStyles: {
      0: { cellWidth: 66 },
      1: { cellWidth: 64 },
      2: { cellWidth: 60 },
    },
    styles: {
      font: 'helvetica',
      cellPadding: 2.5,
      lineColor: [0, 0, 0],
      lineWidth: 0.35,
      overflow: 'linebreak',
    },
  });

  const headerEndY = (pdf as unknown as { lastAutoTable?: { finalY: number } })
    .lastAutoTable?.finalY;
  const tableStartY = headerEndY ? headerEndY + 4 : 36;

  // 2. Plan 4-column table rows
  const col0W = 34;
  const col1W = 62;
  const col2W = 48;
  const col3W = 46; // 34 + 62 + 48 + 46 = 190mm

  const cellPadX = 2;
  const fontSize = 8;
  const lineH = 3.6;
  const minTrackerHeight = 44; // 8 sub-rows * 5.5mm each

  const effectiveTargets: ExportableTargetItem[] =
    targets.length > 0
      ? targets
      : [
          {
            heading: 'Target 1',
            title: 'No targets added yet.',
            challenge: '',
            suggestedStrategies: '',
            fontColor: 'black',
          },
        ];

  const grouped = groupTargetsHierarchically(effectiveTargets);

  const plannedRows: PlannedRow[] = grouped.flatEntries.map((entry, idx) => {
    const tgt = entry.item;
    const rawHeading = (tgt.heading || '').trim();
    let goalTitle: string;
    if (entry.isSubTarget) {
      if (rawHeading) {
        const strippedHeading = rawHeading
          .replace(/^target\s*\d+(?:\.\d+)?\s*[:\-–]?\s*/i, '')
          .trim();
        goalTitle = strippedHeading
          ? `Target ${entry.displayNumber}: ${strippedHeading}`
          : `Target ${entry.displayNumber}`;
      } else {
        goalTitle = `Target ${entry.displayNumber}`;
      }
    } else if (rawHeading) {
      goalTitle = /^target\s*\d+/i.test(rawHeading)
        ? rawHeading
        : `Target ${entry.groupNumber}: ${rawHeading}`;
    } else {
      goalTitle = `Target ${entry.groupNumber}`;
    }
    const col0Lines = wrapTextPreservingNewlines(
      pdf,
      goalTitle,
      col0W - cellPadX * 2,
      'bold',
      fontSize
    );

    const descText = (tgt.title || '').trim() || '—';
    const descLines = wrapTextPreservingNewlines(
      pdf,
      descText,
      col1W - cellPadX * 2,
      'normal',
      fontSize
    );

    const challengeTrimmed = (tgt.challenge || '').trim();
    const challengeLines = challengeTrimmed
      ? wrapTextPreservingNewlines(
          pdf,
          `Challenge: ${challengeTrimmed}`,
          col1W - cellPadX * 2,
          'normal',
          fontSize
        )
      : [];

    const stratText = (tgt.suggestedStrategies || '').trim();
    const stratLines = stratText
      ? wrapTextPreservingNewlines(
          pdf,
          stratText,
          col3W - cellPadX * 2,
          'normal',
          fontSize
        )
      : [];

    const padY = 5;
    const col0H = col0Lines.length * lineH + padY;
    const col1H =
      (descLines.length + challengeLines.length) * lineH +
      (challengeLines.length > 0 ? 1.5 : 0) +
      padY;
    const col3H = stratLines.length * lineH + padY;

    const rowHeight = Math.max(minTrackerHeight, col0H, col1H, col3H);

    return {
      col0Lines,
      descLines,
      challengeLines,
      stratLines,
      rowFillColor: ROW_FILL_PALETTE[idx % ROW_FILL_PALETTE.length],
      rowHeight,
    };
  });

  // 3. Draw 4-column Targets Table
  autoTable(pdf, {
    startY: tableStartY,
    margin: { left: margin, right: margin },
    tableWidth: usableWidth,
    showHead: 'everyPage',
    rowPageBreak: 'avoid',
    head: [
      [
        'Overreaching Goal',
        'SMART Target - A',
        'Progress of SMART Target:\nWT/PA/A/M Ch=Challenge',
        'Suggested Strategies',
      ],
    ],
    body: plannedRows.map((plan) => [
      {
        content: '',
        styles: {
          minCellHeight: plan.rowHeight,
          fillColor: plan.rowFillColor,
        },
      },
      {
        content: '',
        styles: {
          minCellHeight: plan.rowHeight,
          fillColor: plan.rowFillColor,
        },
      },
      {
        content: '',
        styles: {
          minCellHeight: plan.rowHeight,
          fillColor: plan.rowFillColor,
        },
      },
      {
        content: '',
        styles: {
          minCellHeight: plan.rowHeight,
          fillColor: plan.rowFillColor,
        },
      },
    ]),
    columnStyles: {
      0: { cellWidth: col0W },
      1: { cellWidth: col1W },
      2: { cellWidth: col2W, cellPadding: 0 },
      3: { cellWidth: col3W },
    },
    styles: {
      font: 'helvetica',
      fontSize,
      cellPadding: 2,
      lineColor: [0, 0, 0],
      lineWidth: 0.35,
      textColor: [0, 0, 0],
      valign: 'top',
    },
    headStyles: {
      fillColor: [226, 232, 240],
      textColor: [0, 0, 0],
      fontStyle: 'bold',
      fontSize: 8,
      lineColor: [0, 0, 0],
      lineWidth: 0.35,
      halign: 'center',
      valign: 'middle',
    },
    willDrawCell: (data) => {
      if (data.section === 'body') {
        data.cell.text = [];
      }
    },
    didDrawCell: (data) => {
      if (data.section !== 'body') return;
      const plan = plannedRows[data.row.index];
      if (!plan) return;

      const x = data.cell.x;
      const y = data.cell.y;
      const w = data.cell.width;
      const h = data.cell.height;

      if (data.column.index === 0) {
        // Col 1: Overreaching Goal (bold heading)
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(fontSize);
        pdf.setTextColor(0, 0, 0);
        let cursorY = y + 4.5;
        for (const line of plan.col0Lines) {
          if (line) {
            pdf.text(line, x + cellPadX, cursorY);
          }
          cursorY += lineH;
        }
      } else if (data.column.index === 1) {
        // Col 2: SMART Target - A (normal description + bold Challenge:)
        let cursorY = y + 4.5;
        pdf.setTextColor(0, 0, 0);

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(fontSize);
        for (const line of plan.descLines) {
          if (line) {
            pdf.text(line, x + cellPadX, cursorY);
          }
          cursorY += lineH;
        }

        if (plan.challengeLines.length > 0) {
          cursorY += 1.5;
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(fontSize);

          plan.challengeLines.forEach((line, lineIdx) => {
            if (line) {
              if (lineIdx === 0 && line.startsWith('Challenge')) {
                const wordW = pdf.getTextWidth('Challenge');
                pdf.setFillColor(255, 255, 0);
                pdf.rect(
                  x + cellPadX - 0.4,
                  cursorY - 2.8,
                  wordW + 0.8,
                  3.5,
                  'F'
                );
                pdf.setTextColor(0, 0, 0);
              }
              pdf.text(line, x + cellPadX, cursorY);
            }
            cursorY += lineH;
          });
        }
      } else if (data.column.index === 2) {
        // Col 3: 8 rows of Date: ____  Code: ____ inside each target
        const subRowCount = 8;
        const subH = h / subRowCount;
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(6.8);
        pdf.setTextColor(0, 0, 0);

        for (let r = 0; r < subRowCount; r++) {
          const subY = y + r * subH;
          if (r > 0) {
            pdf.setDrawColor(100, 116, 139);
            pdf.setLineWidth(0.2);
            pdf.line(x, subY, x + w, subY);
          }

          const baselineY = subY + subH * 0.68;
          pdf.text('Date:', x + 1.5, baselineY);
          pdf.setDrawColor(51, 65, 85);
          pdf.setLineWidth(0.2);
          pdf.line(x + 8.5, baselineY + 0.5, x + 25.5, baselineY + 0.5);

          pdf.text('Code:', x + 27, baselineY);
          pdf.line(x + 34.5, baselineY + 0.5, x + w - 1.5, baselineY + 0.5);
        }
        // Re-assert crisp black outer border on column 2 cell
        pdf.setDrawColor(0, 0, 0);
        pdf.setLineWidth(0.35);
        pdf.rect(x, y, w, h, 'S');
      } else if (data.column.index === 3) {
        // Col 4: Suggested Strategies
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(fontSize);
        pdf.setTextColor(0, 0, 0);
        let cursorY = y + 4.5;
        for (const line of plan.stratLines) {
          if (line) {
            pdf.text(line, x + cellPadX, cursorY);
          }
          cursorY += lineH;
        }
      }
    },
  });

  // 4. Below the table: Progress Codes Legend with corresponding highlights
  const tableEndY = (pdf as unknown as { lastAutoTable?: { finalY: number } })
    .lastAutoTable?.finalY;
  let legendY = tableEndY ? tableEndY + 6 : tableStartY + 50;

  const legendItems: Array<{
    code: string;
    label: string;
    fill: [number, number, number];
    border: [number, number, number];
  }> = [
    {
      code: 'WT',
      label: '= Working towards SMART Target',
      fill: [253, 216, 142], // WT amber/orange highlight
      border: [217, 119, 6],
    },
    {
      code: 'Ch WT',
      label: '= Challenge Target working towards',
      fill: [254, 240, 138], // Yellow highlight for CH codes
      border: [202, 138, 4],
    },
    {
      code: 'PA',
      label: '= SMART Target achieved',
      fill: [186, 230, 253], // PA sky-blue highlight
      border: [2, 132, 199],
    },
    {
      code: 'Ch PA',
      label: '= Challenge target partly achieved',
      fill: [254, 240, 138], // Yellow highlight for CH codes
      border: [202, 138, 4],
    },
    {
      code: 'A',
      label: '= Achieved SMART Target',
      fill: [187, 247, 208], // A green/emerald highlight
      border: [22, 163, 74],
    },
    {
      code: 'Ch A',
      label: '= Challenge target achieved',
      fill: [254, 240, 138], // Yellow highlight for CH codes
      border: [202, 138, 4],
    },
  ];

  const legendNeededH = 30;
  if (legendY + legendNeededH > pageHeight - 10) {
    pdf.addPage('a4', 'portrait');
    legendY = 14;
  }

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.5);
  pdf.setTextColor(0, 0, 0);
  pdf.text('Codes:', margin, legendY);
  legendY += 2.5;

  const boxW = 93;
  const colGap = 4;
  const boxH = 6.5;
  const rowGap = 2;

  legendItems.forEach((item, idx) => {
    const colIdx = idx % 2;
    const rowIdx = Math.floor(idx / 2);
    const bx = margin + colIdx * (boxW + colGap);
    const by = legendY + rowIdx * (boxH + rowGap);

    pdf.setFillColor(...item.fill);
    pdf.setDrawColor(...item.border);
    pdf.setLineWidth(0.25);
    pdf.roundedRect(bx, by, boxW, boxH, 1, 1, 'FD');

    pdf.setTextColor(0, 0, 0);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.8);
    pdf.text(item.code, bx + 2.5, by + 4.3);

    const codeW = pdf.getTextWidth(`${item.code} `);
    pdf.setFont('helvetica', 'normal');
    pdf.text(item.label, bx + 2.5 + codeW, by + 4.3);
  });

  const safeStudent = cleanStudent.replace(/[^a-zA-Z0-9_-]+/g, '_');
  pdf.save(`${safeStudent}_W3_IEP_Targets.pdf`);
}
