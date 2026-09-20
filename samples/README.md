# Sample data

Synthetic exports for demos and tests (example.com addresses). Upload **both files of a folder together**.

| Folder | Files | Outcome |
| --- | --- | --- |
| `04-helix` | `hr-core.xlsx`, `legacy-crm.xlsx` | **Needs the AI.** Headers like `Emp Code`, `Personnel No.`, `Nombre completo`, `E-mail (work)`, `Mail`, `Org Unit`, `Position Held`, `Onboarding Date`, `Joined On`, `Emp Status`, plus decoys `Favourite Colour`, `Manager Name`. 13 rows → 10 records. Three planted decisions: `04/05/2024` (ambiguous), Lars Jensen's department `Operations` vs `Ops`, and Omar Haddad's missing email. Depending on the model you may also be asked to confirm a column mapping. |
| `01-meridian` | `hr-master.csv`, `company-directory.csv` | Known headers, duplicates across files, messy whitespace/casing, `18/03/2024`. 10 rows → 8 records, **no escalation**, 8 delivered. |
| `02-northstar` | `hr-export.csv`, `acquired-directory.csv` | Ambiguous date `04/05/2024`, department conflict (Operations vs People), missing email. 8 rows → 6 records, 3 cases. |
| `03-cedar` | `payroll-export.csv`, `staff-directory.csv` | Shared email between two people, impossible date `2024-02-30`, a draft record to reject. 6 rows → 5 records, 3 cases (4 delivered + 1 rejected). |

Suggested answers: Northstar → date `2024-05-04`, department `People`, email `lucas.reed@example.com`. Helix → date `2024-05-04`, department `Operations`, email `omar.haddad@example.com`.

`npm run samples` regenerates the Helix workbooks (`scripts/make-samples.ts`).

## More targets to try

Each has a matching ready-made target in the app (step 2 → *Ready-made* → **Use the sample files**), and the same target written in a different input format under `schemas/`.

| Folder | Target | Also try it as | Planted problems |
| --- | --- | --- | --- |
| `05-payroll` — `finance-ledger.xlsx`, `hr-portal.csv` | Payroll roster | `schemas/payroll.schema.json` (JSON Schema) | salary `1,150,000` (not an integer), grade `G5` (not in the list), Julia's salary differs between files, `06/07/2023` (ambiguous) |
| `06-crm` — `newsletter-export.csv`, `sales-pipeline.xlsx` | CRM contacts | `schemas/crm.sample-record.json` (a sample record) | country `Narnia`, spend `-50`, `03/04/2023` (ambiguous); `Subscribed` is a decoy the AI may or may not be tempted by |
| `07-catalogue` — `warehouse.csv`, `webshop.xlsx` | Product catalogue | `schemas/catalogue.fields.json` (names + types) | price `19,99`, SKU `ts-104 `, stock `many`, stock `120` vs `118`, `05/06/2024` |
| `04-helix` | Employee directory | `schemas/employee.names.json` (**just names**) and `schemas/employee.fields.yaml` | see above |

With names only, only the identity field is required, so a blank email is accepted; declare `email` as required (Build fields → toggle) to have blank emails escalated.
