#!/bin/bash
set -e

createdb --username "$POSTGRES_USER" --template template_postgis "$POSTGRES_DB_TEST"
