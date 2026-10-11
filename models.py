from sqlalchemy import Column, Integer, String, Float, ForeignKey
from database import Base

class Item(Base):
    __tablename__ = "items"

    id = Column(Integer, primary_key=True, index=True)
    item_number = Column(String, unique=True, index=True)  # e.g., "ASM-001"
    type = Column(String)                                  # "Assembly" or "Part"
    name = Column(String)
    make_or_buy = Column(String)
    unit_cost = Column(Float, default=0.0)
    qty_on_hand = Column(Integer, default=0)
    procurement_status = Column(String, default="Planned")
    drive_link = Column(String, default="")

class BomLink(Base):
    __tablename__ = "bom_links"

    id = Column(Integer, primary_key=True, index=True)
    parent_id = Column(Integer, ForeignKey("items.id"))
    child_id = Column(Integer, ForeignKey("items.id"))
    quantity = Column(Float, default=1.0)