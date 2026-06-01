#!/usr/bin/env python3
"""
Deprecated.

Apache configuration is now managed by deploy.py using
infra/apache/agh-viewer.conf. This script intentionally does not patch
/etc/apache2/sites-available/agents.conf anymore.
"""
import sys


print("Deprecated: Apache config is installed by deploy.py from infra/apache/agh-viewer.conf.")
sys.exit(2)
