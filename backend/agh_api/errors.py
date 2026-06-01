class APIError(Exception):
    status_code = 500
    message = "Internal server error"

    def __init__(self, message=None, status_code=None):
        super().__init__(message or self.message)
        if message is not None:
            self.message = message
        if status_code is not None:
            self.status_code = status_code


class BadRequest(APIError):
    status_code = 400
    message = "Bad request"


class NotFound(APIError):
    status_code = 404
    message = "Not found"


class Conflict(APIError):
    status_code = 409
    message = "Conflict"


class UnsupportedTiff(APIError):
    status_code = 422
    message = "Unsupported TIFF layout"
