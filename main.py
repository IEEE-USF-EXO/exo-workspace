from fastapi import FastAPI, Depends, Request, Form
from fastapi.templating import Jinja2Templates
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
import models
from database import engine, SessionLocal

# This tells SQLAlchemy to create the tables in your database
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Exo PLM")

# This tells FastAPI where your HTML files live
templates = Jinja2Templates(directory="templates")

# This safely opens and closes the database connection for every request
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()