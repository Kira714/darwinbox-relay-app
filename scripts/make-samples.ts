/**
 * Regenerates the demo data:
 *   samples/04-helix     Excel, employee schema. Unfamiliar headers force the AI mapper to work; the data
 *                        plants three problems a person must decide (ambiguous date, conflict, missing email).
 *   samples/05-payroll   camelCase payroll schema, xlsx + csv.
 *   samples/06-crm       CRM contacts schema, csv + xlsx.
 *   samples/07-catalogue product catalogue schema, csv + xlsx.
 *   samples/schemas      the same targets written in each accepted input format.
 */
import ExcelJS from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import { payrollPreset } from '../server/presets.js';

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

// ---- generic writers ---------------------------------------------------------------
async function sheet(dir: string, file: string, name: string, rows: unknown[][], widths: number[]) {
  await mkdir(dir, { recursive: true });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => (c.width = widths[i] ?? 16));
  await wb.xlsx.writeFile(`${dir}/${file}`);
}
const csvCell = (v: unknown) =>
  /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
async function csv(dir: string, file: string, rows: unknown[][]) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${file}`, rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
}

// ---- 05 payroll: Excel with unfamiliar headers + a portal CSV that matches by alias ---------
await sheet(
  'samples/05-payroll',
  'finance-ledger.xlsx',
  'Ledger',
  [
    [
      'Staff No',
      'Full Legal Name',
      'Corporate Mail',
      'Pay Grade',
      'Annual CTC',
      'Full Time?',
      'Date Joined',
      'Cost Centre',
    ],
    [
      'PY0101',
      'Anita Desai',
      'anita.desai@example.com',
      'G3',
      1850000,
      'Yes',
      d('2021-04-05'),
      'CC-11',
    ],
    [
      'PY0102',
      'Rohit Verma',
      'rohit.verma@example.com',
      'G2',
      1200000,
      'Yes',
      d('2022-08-16'),
      'CC-12',
    ],
    [
      'PY0103',
      'Julia Santos',
      'julia.santos@example.com',
      'G4',
      2600000,
      'yes',
      d('2019-01-21'),
      'CC-11',
    ],
    [
      'PY0104',
      'Kenji Ito',
      'kenji.ito@example.com',
      'G2',
      '1,150,000',
      'Yes',
      d('2020-10-12'),
      'CC-13',
    ],
    ['PY0105', 'Farah Khan', 'farah.khan@example.com', 'G1', 640000, 'No', '06/07/2023', 'CC-12'],
    ['PY0106', 'Omar Ali', 'omar.ali@example.com', 'G5', 990000, 'Yes', d('2022-02-01'), 'CC-14'],
  ],
  [11, 22, 30, 11, 13, 12, 14, 12],
);
await csv('samples/05-payroll', 'hr-portal.csv', [
  ['StaffCode', 'Name', 'Email', 'Band', 'Salary', 'Full Time'],
  ['PY0101', 'Anita Desai', 'ANITA.DESAI@example.com', 'G3', 1850000, 'Yes'],
  ['PY0103', 'Julia Santos', 'julia.santos@example.com', 'G4', 2650000, 'Yes'],
  ['PY0107', 'Mateo Ruiz', 'mateo.ruiz@example.com', 'G2', 1300000, 'Yes'],
  ['PY0108', 'Zainab Sheikh', 'zainab.sheikh@example.com', 'G1', 700000, 'No'],
]);

// ---- 06 crm ---------------------------------------------------------------------------
await csv('samples/06-crm', 'newsletter-export.csv', [
  ['Contact Ref', 'E-mail Address', 'Organisation', 'Country', 'Signed Up On', 'Subscribed'],
  ['C-1001', 'mira.kapoor@example.com', 'Northwind Traders', 'India', '2024-01-12', 'yes'],
  ['C-1002', 'liam.oconnor@example.com', 'Contoso Ltd', 'United Kingdom', '2023-11-30', 'yes'],
  ['C-1003', 'sara.lindqvist@example.com', 'Fabrikam AB', 'Germany', '03/04/2024', 'no'],
  ['C-1004', 'dev.patel@example.com', 'Tailspin Toys', 'USA', '2024-03-03', 'yes'],
  ['C-1005', 'kim.tran@example.com', '', 'Singapore', '2024-04-21', 'yes'],
]);
await sheet(
  'samples/06-crm',
  'sales-pipeline.xlsx',
  'Pipeline',
  [
    ['Lead ID', 'Email', 'Account Name', 'Country/Region', 'Total Spend (USD)', 'Customer?'],
    ['C-1001', 'MIRA.KAPOOR@example.com', 'Northwind Traders', 'India', 48250.75, 'Yes'],
    ['C-1004', 'dev.patel@example.com', 'Tailspin Toys', 'United States', 1200, 'Yes'],
    ['C-1006', 'noor.rahman@example.com', 'Wingtip Bikes', 'Narnia', 300, 'No'],
    ['C-1007', 'ana.costa@example.com', 'Litware Inc', 'United Kingdom', -50, 'No'],
  ],
  [10, 30, 22, 16, 18, 12],
);

// ---- 07 catalogue -----------------------------------------------------------------------
await csv('samples/07-catalogue', 'warehouse.csv', [
  ['Item Code', 'Product Title', 'Dept', 'Unit Price', 'Qty On Hand', 'Live?', 'Launch Date'],
  ['TS-100', 'Trail Runner Shoe', 'Shoes', '89.90', 120, 'yes', '2023-09-01'],
  ['TS-101', 'Merino Beanie', 'Accessories', '24.50', 340, 'yes', '2023-10-15'],
  ['TS-102', 'Canvas Tote', 'Accessories', '19,99', 210, 'yes', '2023-11-02'],
  ['TS-103', 'Linen Throw', 'Homeware', '59.00', 45, 'no', '2024-02-10'],
  ['ts-104 ', 'Denim Jacket', 'Clothing', '120.00', 60, 'yes', '2024-03-01'],
  ['TS-105', 'Wool Scarf', 'Accessories', '34.00', 'many', 'yes', '2024-01-20'],
]);
await sheet(
  'samples/07-catalogue',
  'webshop.xlsx',
  'Products',
  [
    ['SKU', 'Title', 'Category', 'Price (USD)', 'Stock', 'Published', 'First Listed'],
    ['TS-100', 'Trail Runner Shoe', 'footwear', 89.9, 118, 'Yes', d('2023-09-01')],
    ['TS-101', 'Merino Beanie', 'accessories', 24.5, 340, 'Yes', d('2023-10-15')],
    ['TS-106', 'Cork Yoga Mat', 'home', 45, 80, 'Yes', d('2024-04-05')],
    ['TS-107', 'Rain Shell', 'apparel', 99, 25, 'No', '05/06/2024'],
  ],
  [10, 24, 14, 14, 10, 12, 14],
);

// ---- the same targets, written the ways a person might write them ----------------------
const schemas = 'samples/schemas';
await mkdir(schemas, { recursive: true });
await writeFile(
  `${schemas}/payroll.schema.json`,
  JSON.stringify(payrollPreset.schema, null, 2) + '\n',
);
await writeFile(
  `${schemas}/crm.sample-record.json`,
  JSON.stringify(
    {
      contact_id: 'C-1001',
      email: 'mira.kapoor@example.com',
      company: 'Northwind Traders',
      country: 'IN',
      lifetime_value: 48250.75,
      is_customer: true,
      signed_up: '2024-01-12',
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  `${schemas}/catalogue.fields.json`,
  JSON.stringify(
    {
      sku: 'string!',
      name: 'string!',
      category: 'string',
      price: 'number!',
      stock: 'whole number',
      active: 'yes/no',
      launched: 'date',
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  `${schemas}/employee.names.json`,
  JSON.stringify(
    [
      'employee_id',
      'full_name',
      'email',
      'department',
      'job_title',
      'start_date',
      'employment_status',
    ],
    null,
    2,
  ) + '\n',
);
await writeFile(
  `${schemas}/employee.fields.yaml`,
  '# Field list with types. "!" marks a required field.\nemployee_id: string!\nfull_name: string!\nemail: email!\ndepartment: string\njob_title: string\nstart_date: date\nemployment_status: string\n',
);
console.log('Wrote samples/04-helix, 05-payroll, 06-crm, 07-catalogue and samples/schemas');
