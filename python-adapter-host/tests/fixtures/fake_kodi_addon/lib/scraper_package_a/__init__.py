"""Project-authored package instance of the verified external-scraper contract."""
from external_scraper_fixture import providers


def sources(specified_folders=None, ret_all=False):
    return providers('a', specified_folders, ret_all)
