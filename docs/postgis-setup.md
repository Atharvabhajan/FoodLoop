# Installing PostGIS natively (no Docker)

FoodLoop Phase 4 needs PostGIS on the **existing** PostgreSQL installation. Do not reinstall or upgrade PostgreSQL, and do not change its data directory; PostGIS installs alongside it and your databases are untouched.

## Detected environment

- PostgreSQL **18.4**, EnterpriseDB build for Windows x64, at `C:\Program Files\PostgreSQL\18`, service `postgresql-x64-18`.
- Data directory `C:/Program Files/PostgreSQL/18/data`. Databases: `foodloop` (dev), `foodloop_test` (tests); `mntx_db` and `p2h_dev` belong to other projects and are never touched.
- Stack Builder 4.2.2 is installed (`C:\Program Files\PostgreSQL\18\bin\stackbuilder.exe`).
- Before installation, `pg_available_extensions` contains **no** `postgis*` entries.

## Windows steps (EnterpriseDB installation)

1. You do not need an elevated terminal to launch Stack Builder, but the PostGIS installer it downloads writes into `C:\Program Files` and will ask for administrator approval (UAC). Approve it for that installer only.
2. Start Menu → *Application Stack Builder* (or run `"C:\Program Files\PostgreSQL\18\bin\stackbuilder.exe"`).
3. Choose the server **PostgreSQL 18 (x64) on port 5432** → *Next*.
4. Expand **Spatial Extensions** and tick **PostGIS 3.x Bundle for PostgreSQL 18 (64 bit)**. If no PostgreSQL 18 bundle is listed, stop: do not pick a bundle built for another major version, because it will not load. Check the Stack Builder catalogue again later or use the EDB-published PostGIS installer for PG 18.
5. Accept the defaults. Answer **No** when asked to create a spatial database, and **No** to the optional environment-variable/GDAL prompts unless you want them. The installer must not touch existing databases.
6. Restart the service so the new extension files load (PowerShell as administrator): `Restart-Service postgresql-x64-18`.

## Result on this machine

Verified after installation: PostgreSQL 18.6 (the installer also updated the server from 18.4 in place; the databases were untouched) with **PostGIS 3.6.2**. `npm run db:check-postgis` printed `PostGIS_Full_Version()` and a Pune to Mumbai distance of 120.1 km. The Phase 4 migration then enabled PostGIS in `foodloop` and `foodloop_test`.

## Verify (isolated first, then FoodLoop databases)

```bash
npm run db:check-postgis
```

This command:
1. prints the server version and whether `postgis*` is available (exit code 2 and no changes if it is not);
2. creates a throwaway database `foodloop_postgis_check`, runs `CREATE EXTENSION postgis`, prints `PostGIS_Full_Version()`, checks the Pune to Mumbai geodesic distance (about 120 km, longitude as X and latitude as Y), then drops the throwaway database;
3. reports read-only whether PostGIS is enabled in the dev and test databases (it is only enabled there by the Phase 4 migration).

Only after step 2 succeeds should the Phase 4 migration be run against `foodloop` and `foodloop_test`.

## macOS / Linux

`brew install postgis` (match your PostgreSQL major version), or `sudo apt install postgresql-18-postgis-3`, then restart PostgreSQL and run `npm run db:check-postgis`.
