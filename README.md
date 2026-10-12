# HEALTH-11 database tests

Copy the `tests` folder into the root of your local `HEALTH-11` checkout.

Run from PowerShell at `C:\Users\shrut\HEALTH-11`:

```powershell
$envValues = @{}
Get-Content .env.test | ForEach-Object {
    if ($_ -match '^\s*TEST_DATABASE_URL\s*=\s*(.*)$') {
        $env:TEST_DATABASE_URL = $matches[1].Trim().Trim('"').Trim("'")
    }
}
if (-not $env:TEST_DATABASE_URL -or -not $env:TEST_DATABASE_URL.EndsWith('/health11_test')) {
    throw 'Refusing to run tests: TEST_DATABASE_URL must point to /health11_test'
}
$env:DATABASE_URL = $env:TEST_DATABASE_URL
.\.venv\Scripts\python.exe -m pytest -v
```

This suite does not create/drop tables or run migrations. It expects the migration to have been applied to `health11_test`.
It wraps each test in a transaction and rolls the test data back. No commit is performed.
