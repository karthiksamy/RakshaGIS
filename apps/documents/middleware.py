class StripOnlyOfficeAuthorizationMiddleware:
    """Remove Authorization header for OnlyOffice callback URLs.

    OnlyOffice may send a Bearer token in the Authorization header which
    DRF/SimpleJWT will attempt to validate before the view runs. For the
    callback endpoint we prefer the JWT passed in the POST body; remove the
    header early so authentication classes are not triggered.
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            path = request.path or ''
            if path.startswith('/api/documents/') and path.endswith('/onlyoffice-callback/'):
                request.META.pop('HTTP_AUTHORIZATION', None)
        except Exception:
            pass
        return self.get_response(request)
