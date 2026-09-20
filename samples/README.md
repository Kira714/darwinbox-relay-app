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
