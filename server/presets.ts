import type { Configuration } from './configuration.js';

export interface Preset {
  id: string;
  name: string;
  description: string;
  schema: Configuration['schema'];
  identityField: string;
}

export const employeePreset: Preset = {
  id: 'employee',
  name: 'Employee directory',
  description: 'Core HR fields for an employee master record.',
  identityField: 'employee_id',
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

export const presets: Preset[] = [employeePreset];

export const defaultConfiguration = (): Configuration => ({
  schema: structuredClone(employeePreset.schema),
  identityField: employeePreset.identityField,
  destination: { kind: 'reference' },
});
