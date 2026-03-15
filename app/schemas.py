from pydantic import BaseModel

class TokenRequest(BaseModel):
    token: str

class SessionStartRequest(BaseModel):
    token: str
    userName: str

class SessionFinishRequest(BaseModel):
    token: str
    folder: str
    questionsCount: int

class AdminLoginRequest(BaseModel):
    username: str
    password: str