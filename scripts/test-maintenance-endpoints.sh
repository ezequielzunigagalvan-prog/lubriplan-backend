#!/bin/bash

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

API_URL="http://localhost:3001/api/maintenance"
TOKEN="${JWT_TOKEN:-}" # Debería pasar un token JWT válido

echo -e "${YELLOW}🧪 Testing Lubriplan Maintenance Endpoints${NC}\n"

# Test 1: Dashboard Summary
echo -e "${YELLOW}1. Testing GET /api/maintenance/dashboard/summary${NC}"
curl -s -X GET "$API_URL/dashboard/summary" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | jq . && echo -e "${GREEN}✓ Dashboard Summary OK${NC}\n" || echo -e "${RED}✗ Dashboard Summary FAILED${NC}\n"

# Test 2: List Assets
echo -e "${YELLOW}2. Testing GET /api/maintenance/assets${NC}"
curl -s -X GET "$API_URL/assets?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | jq . && echo -e "${GREEN}✓ Assets List OK${NC}\n" || echo -e "${RED}✗ Assets List FAILED${NC}\n"

# Test 3: List Work Orders
echo -e "${YELLOW}3. Testing GET /api/maintenance/work-orders${NC}"
curl -s -X GET "$API_URL/work-orders?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | jq . && echo -e "${GREEN}✓ Work Orders List OK${NC}\n" || echo -e "${RED}✗ Work Orders List FAILED${NC}\n"

# Test 4: Reportar Falla (requires valid assetId)
echo -e "${YELLOW}4. Testing POST /api/maintenance/reportar-falla${NC}"
# You'll need to adjust assetId based on your data
curl -s -X POST "$API_URL/reportar-falla" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "assetId": 1,
    "title": "Prueba de reporte de falla",
    "description": "Descripción de prueba",
    "priority": "HIGH"
  }' | jq . && echo -e "${GREEN}✓ Report Failure OK${NC}\n" || echo -e "${RED}✗ Report Failure FAILED${NC}\n"

# Test 5: Seed Failure Codes
echo -e "${YELLOW}5. Testing POST /api/maintenance/failure-codes/seed${NC}"
curl -s -X POST "$API_URL/failure-codes/seed" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" | jq . && echo -e "${GREEN}✓ Seed Failure Codes OK${NC}\n" || echo -e "${RED}✗ Seed Failure Codes FAILED${NC}\n"

echo -e "${YELLOW}✅ Testing completed!${NC}"
