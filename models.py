from sqlalchemy import Column, Integer, String, Float, ForeignKey
from database import Base

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    item_id = Column(String, unique=True, index=True)      # e.g., "D01"
    subsystem = Column(String)                             # "Active drive", "Mechanical", etc.
    component_name = Column(String)                        
    purpose = Column(String)                               # Integration purpose
    qty = Column(Integer, default=1)
    unit_cost = Column(Float, nullable=True)               # Can be 0 or null for unpriced quotes
    supplier_link = Column(String, default="")
    cost_basis = Column(String)                            # "Vendor", "Allowance", "Quote"
    stage = Column(String, default="Baseline")             # "Baseline" or "Optional"