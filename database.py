from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base

# We are using a local SQLite file for testing. 
# Later, we will change this one line to connect to Aiven MySQL.
SQLALCHEMY_DATABASE_URL = "sqlite:///./plm.db"

# check_same_thread is needed only for SQLite
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()