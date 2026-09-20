import type { Configuration } from './configuration.js';

export interface Preset {
  id: string;
  name: string;
  description: string;
  schema: Configuration['schema'];
  identityField: string;
  /** Sample files (in samples/<folder>) that exercise this schema; offered in the UI. */
  sample: { folder: string; files: string[] };
}

export const employeePreset: Preset = {
  id: 'employee',
  name: 'Employee directory',
  description: 'Core HR fields for an employee master record.',
  identityField: 'employee_id',
  sample: { folder: '04-helix', files: ['hr-core.xlsx', 'legacy-crm.xlsx'] },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Employee',
    type: 'object',
    additionalProperties: false,
    required: ['employee_id', 'full_name', 'email'],
    properties: {
      employee_id: {
        type: 'string',
        title: 'Employee ID',
        description: 'Unique staff identifier or personnel code.',
        minLength: 1,
        maxLength: 64,
        pattern: '^[\\p{L}\\p{N}_-]+$',
        'x-aliases': [
          'staff id',
          'emp id',
          'employee code',
          'employee number',
          'staff number',
          'personnel code',
        ],
      },
      full_name: {
        type: 'string',
        title: 'Full name',
        description: "Employee's complete first and last name.",
        minLength: 2,
        maxLength: 160,
        'x-aliases': ['name', 'employee name', 'legal name'],
      },
      email: {
        type: 'string',
        format: 'email',
        title: 'Work email',
        description: 'Work email address; lowercased and unique per employee.',
        maxLength: 254,
        'x-unique': true,
        'x-aliases': ['email address', 'work email', 'business email', 'corporate email'],
      },
      department: {
        type: 'string',
        title: 'Department',
        description: 'Team, division or business unit.',
        maxLength: 120,
        'x-aliases': ['dept', 'team', 'division', 'business unit'],
      },
      job_title: {
        type: 'string',
        title: 'Job title',
        description: 'Role, designation or position.',
        maxLength: 120,
        'x-aliases': ['designation', 'position', 'role', 'title'],
      },
      start_date: {
        type: 'string',
        format: 'date',
        title: 'Start date',
        description: 'Joining or hire date as a real calendar date.',
        'x-aliases': ['hire date', 'joining date', 'date of joining', 'date joined', 'doj'],
      },
      employment_status: {
        type: 'string',
        title: 'Employment status',
        description: 'Whether the person is currently employed.',
        enum: ['active', 'inactive', 'on_leave'],
        'x-aliases': ['status', 'employee status'],
        'x-value-aliases': { employed: 'active', terminated: 'inactive', 'on leave': 'on_leave' },
      },
    },
  },
};

const schema = (
  title: string,
  required: string[],
  properties: Preset['schema']['properties'],
): Preset['schema'] => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title,
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

/** Payroll roster: camelCase names that match no employee alias, so the AI has to earn its keep. */
export const payrollPreset: Preset = {
  id: 'payroll',
  name: 'Payroll roster',
  description: 'camelCase fields, integer salary, yes/no flag, grade list.',
  identityField: 'staffCode',
  sample: { folder: '05-payroll', files: ['finance-ledger.xlsx', 'hr-portal.csv'] },
  schema: schema('Payroll roster', ['staffCode', 'fullName', 'workEmail', 'salary'], {
    staffCode: {
      type: 'string',
      title: 'Staff code',
      description: 'Unique payroll code: two capital letters and four digits.',
      pattern: '^[A-Z]{2}\\d{4}$',
      'x-aliases': ['staff code', 'employee id'],
    },
    fullName: {
      type: 'string',
      title: 'Full name',
      description: "The employee's full legal name.",
      minLength: 2,
      'x-aliases': ['name', 'employee name'],
    },
    workEmail: {
      type: 'string',
      format: 'email',
      title: 'Work email',
      description: 'Company email address.',
      'x-unique': true,
      'x-aliases': ['email', 'email address'],
    },
    grade: {
      type: 'string',
      title: 'Pay grade',
      description: 'Pay band from G1 (junior) to G4 (senior).',
      enum: ['G1', 'G2', 'G3', 'G4'],
      'x-aliases': ['band', 'pay band'],
    },
    salary: {
      type: 'integer',
      title: 'Annual salary',
      description: 'Annual compensation in whole rupees.',
      minimum: 0,
      'x-aliases': ['salary', 'annual salary'],
    },
    fullTime: {
      type: 'boolean',
      title: 'Full time',
      description: 'Whether the employee works full time.',
      'x-aliases': ['full time'],
    },
    joinedOn: {
      type: 'string',
      format: 'date',
      title: 'Joining date',
      description: 'Date the employee joined.',
      'x-aliases': ['date joined', 'joined on', 'joining date'],
    },
  }),
};

/** CRM contacts: country names normalise to ISO codes automatically via x-value-aliases. */
export const crmPreset: Preset = {
  id: 'crm',
  name: 'CRM contacts',
  description: 'Contacts with ISO country codes, a money amount and a customer flag.',
  identityField: 'contact_id',
  sample: { folder: '06-crm', files: ['newsletter-export.csv', 'sales-pipeline.xlsx'] },
  schema: schema('CRM contact', ['contact_id', 'email'], {
    contact_id: {
      type: 'string',
      title: 'Contact ID',
      description: 'Unique contact reference.',
      'x-aliases': ['contact ref', 'lead id'],
    },
    email: {
      type: 'string',
      format: 'email',
      title: 'Email',
      description: 'Primary email address.',
      'x-unique': true,
      'x-aliases': ['e-mail address', 'email address'],
    },
    company: {
      type: 'string',
      title: 'Company',
      description: 'Organisation the contact works for.',
      'x-aliases': ['organisation', 'account name'],
    },
    country: {
      type: 'string',
      title: 'Country',
      description: 'Two-letter country code.',
      enum: ['IN', 'US', 'GB', 'DE', 'SG'],
      'x-aliases': ['country region'],
      'x-value-aliases': {
        india: 'IN',
        'united states': 'US',
        usa: 'US',
        'united kingdom': 'GB',
        uk: 'GB',
        germany: 'DE',
        singapore: 'SG',
      },
    },
    lifetime_value: {
      type: 'number',
      title: 'Lifetime value',
      description: 'Total spend in USD.',
      minimum: 0,
      'x-aliases': ['total spend'],
    },
    is_customer: {
      type: 'boolean',
      title: 'Is customer',
      description: 'True once the contact has bought something.',
      'x-aliases': ['customer'],
    },
    signed_up: {
      type: 'string',
      format: 'date',
      title: 'Signed up',
      description: 'Date the contact signed up.',
      'x-aliases': ['signed up on'],
    },
  }),
};

/** Product catalogue: pattern-checked SKU, decimal price, stock count. */
export const cataloguePreset: Preset = {
  id: 'catalogue',
  name: 'Product catalogue',
  description: 'SKU pattern, decimal price, whole-number stock, category list.',
  identityField: 'sku',
  sample: { folder: '07-catalogue', files: ['warehouse.csv', 'webshop.xlsx'] },
  schema: schema('Product', ['sku', 'name', 'price'], {
    sku: {
      type: 'string',
      title: 'SKU',
      description: 'Stock keeping unit: capital letters, digits and hyphens.',
      pattern: '^[A-Z0-9-]+$',
      'x-aliases': ['item code', 'product code'],
    },
    name: {
      type: 'string',
      title: 'Product name',
      description: 'Display name.',
      minLength: 2,
      'x-aliases': ['product title', 'title'],
    },
    category: {
      type: 'string',
      title: 'Category',
      description: 'Merchandising category.',
      enum: ['apparel', 'footwear', 'accessories', 'home'],
      'x-aliases': ['dept', 'department'],
      'x-value-aliases': { clothing: 'apparel', shoes: 'footwear', homeware: 'home' },
    },
    price: {
      type: 'number',
      title: 'Price',
      description: 'Unit price in USD.',
      minimum: 0,
      'x-aliases': ['unit price'],
    },
    stock: {
      type: 'integer',
      title: 'Stock',
      description: 'Units on hand.',
      minimum: 0,
      'x-aliases': ['qty on hand', 'quantity'],
    },
    active: {
      type: 'boolean',
      title: 'Active',
      description: 'Whether the product is on sale.',
      'x-aliases': ['live', 'published'],
    },
    launched: {
      type: 'string',
      format: 'date',
      title: 'Launched',
      description: 'First day on sale.',
      'x-aliases': ['launch date', 'first listed'],
    },
  }),
};

export const presets: Preset[] = [employeePreset, payrollPreset, crmPreset, cataloguePreset];

export const defaultConfiguration = (): Configuration => ({
  schema: structuredClone(employeePreset.schema),
  identityField: employeePreset.identityField,
  destination: { kind: 'reference' },
});
