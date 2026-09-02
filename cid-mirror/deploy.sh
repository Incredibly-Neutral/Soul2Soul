#!/usr/bin/env bash
rsync -avz ../cid-mirror/ joera:/srv/s3nl-mirror/
rsync -avz ../cid-mirror/.env joera:/srv/s3nl-mirror/.env