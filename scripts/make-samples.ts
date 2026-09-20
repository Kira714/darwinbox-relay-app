/**
 * Regenerates the Excel demo scenario in samples/04-helix. Unfamiliar headers force the AI
 * mapper to work; the data plants exactly three problems a person must decide:
 * an ambiguous date, a department conflict between files, and a missing email.
 */
import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';

const dir = 'samples/04-helix';
await mkdir(dir, { recursive: true });
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function book(file: string, sheet: string, rows: unknown[][], widths: number[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = widths[i]));
  ws.getColumn(6).numFmt = 'yyyy-mm-dd';
  await wb.xlsx.writeFile(`${dir}/${file}`);
}

await book(
  'hr-core.xlsx',
  'Employees',
  [
    [
      'Emp Code',
      'Nombre completo',
      'E-mail (work)',
      'Org Unit',
      'Position Held',
      'Onboarding Date',
      'Emp Status',
      'Favourite Colour',
    ],
    [
      'HX-101',
      'Priya Nair',
      'priya.nair@example.com',
      'Engineering',
      'Backend Engineer',
      d('2023-05-15'),
      'Active',
      'Teal',
    ],
    [
      'HX-102',
      'Tomás Silva',
      'tomas.silva@example.com',
      'Design',
      'Product Designer',
      '27/03/2024',
      'Active',
      'Green',
    ],
    [
      'HX-103',
      'Grace Okoye',
      'grace.okoye@example.com',
      'Finance',
      'Financial Controller',
      d('2022-09-01'),
      'On Leave',
      'Blue',
    ],
    [
      'HX-104',
      'Lars Jensen',
      'lars.jensen@example.com',
      'Operations',
      'Ops Lead',
      '04/05/2024',
      'Active',
      'Red',
    ],
    [
      'HX-105',
      'Mei Tanaka',
      'mei.tanaka@example.com',
      'Engineering',
      'Site Reliability Engineer',
      d('2021-11-22'),
      'Terminated',
      'Purple',
    ],
    ['HX-106', 'Omar Haddad', '', 'People', 'Recruiter', d('2024-02-19'), 'Active', 'Orange'],
    [
      'HX-107',
      'Chloe Martin',
      'chloe.martin@example.com',
      'Sales',
      'Account Executive',
      d('2023-07-10'),
      'Active',
      'Yellow',
    ],
    [
      'HX-108',
      'Ravi Menon',
      'ravi.menon@example.com',
      'Engineering',
      'Data Engineer',
      d('2024-01-08'),
      'active',
      'Grey',
    ],
  ],
  [12, 22, 30, 16, 26, 18, 14, 18],
);
await book(
  'legacy-crm.xlsx',
  'Contacts',
  [
    ['Personnel No.', 'Name', 'Mail', 'Division', 'Role', 'Joined On', 'Manager Name'],
    [
      'HX-101',
      'Priya Nair',
      'PRIYA.NAIR@example.com',
      'Engineering',
      'Backend Engineer',
      '15/05/2023',
      'Dana Whitfield',
    ],
    [
      'HX-103',
      'Grace Okoye',
      'grace.okoye@example.com',
      'Finance',
      'Financial Controller',
      '2022-09-01',
      'Dana Whitfield',
    ],
    [
      'HX-104',
      'Lars Jensen',
      'lars.jensen@example.com',
      'Ops',
      'Ops Lead',
      '2024-05-04',
      'Dana Whitfield',
    ],
    [
      'HX-109',
      'Sofia Rossi',
      'sofia.rossi@example.com',
      'Legal',
      'Legal Counsel',
      '18/06/2023',
      'Dana Whitfield',
    ],
    [
      'HX-110',
      'Yusuf Karim',
      'yusuf.karim@example.com',
      'Sales',
      'Sales Manager',
      '2020-03-02',
      'Dana Whitfield',
    ],
  ],
  [14, 22, 30, 16, 26, 16, 18],
);
console.log('Wrote samples/04-helix/hr-core.xlsx and legacy-crm.xlsx');
